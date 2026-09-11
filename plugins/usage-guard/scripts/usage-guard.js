'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const USAGE_TOOL_NAME = 'mcp__codex_app__get_usage_limits';
const AUTOMATION_TOOL_NAME = 'mcp__codex_app__automation_update';
const FRESH_SECONDS = 120;
const STALE_SECONDS = 300;
const QUERY_TIMEOUT_SECONDS = 10;
const RESUME_SAFETY_SECONDS = 180;
const RESUME_MAX_WAIT_SECONDS = 21600;
const LOCK_STALE_MS = 30_000;

function utcNow() {
  const configured = process.env.USAGE_GUARD_NOW_UTC;
  const value = configured ? new Date(configured) : new Date();
  if (Number.isNaN(value.getTime())) throw new Error('USAGE_GUARD_NOW_UTC is invalid.');
  return value;
}

function isoNow() {
  return utcNow().toISOString();
}

function getValue(object, name) {
  if (object === null || object === undefined || typeof object !== 'object') return null;
  return Object.prototype.hasOwnProperty.call(object, name) ? object[name] : null;
}

function safeId(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'unknown';
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function dataRoot() {
  const configured = process.env.PLUGIN_DATA;
  return path.resolve(configured && configured.trim() ? configured : path.join(os.tmpdir(), 'codex-usage-guard'));
}

function statePath() {
  return path.join(dataRoot(), 'state.json');
}

function turnPath(sessionId, turnId) {
  return path.join(dataRoot(), 'turns', safeId(String(sessionId ?? '')), `${safeId(String(turnId ?? ''))}.json`);
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let lastError;
  for (const delay of [0, 10, 25, 50, 100, 200, 400, 800, 1200]) {
    if (delay) sleepSync(delay);
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      return { handle, lockPath };
    } catch (error) {
      lastError = error;
      if (error.code !== 'EEXIST') break;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) fs.unlinkSync(lockPath);
      } catch {
        // The competing writer may have released the lock.
      }
    }
  }
  throw lastError ?? new Error(`Could not acquire lock for ${filePath}.`);
}

function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.handle); } catch { /* best effort */ }
  try { fs.unlinkSync(lock.lockPath); } catch { /* best effort */ }
}

function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const lock = acquireLock(filePath);
  const temporary = `${filePath}.${randomUUID().replaceAll('-', '')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
    let lastError;
    for (const delay of [0, 25, 75, 150]) {
      if (delay) sleepSync(delay);
      try {
        fs.renameSync(temporary, filePath);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    releaseLock(lock);
  }
}

function newResumePlan(overrides = {}) {
  return {
    eligible: false,
    blockingWindows: [],
    blockingResetAt: null,
    wakeAt: null,
    waitSeconds: null,
    scheduleKey: null,
    status: 'NONE',
    automationId: null,
    lastError: null,
    updatedAt: isoNow(),
    ...overrides,
  };
}

function newDefaultState() {
  return {
    schemaVersion: 2,
    lastSuccessfulAt: null,
    windows: { primary: null, secondary: null },
    previousPolicy: null,
    currentPolicy: 'UNKNOWN',
    changedAt: null,
    reasonCode: 'NO_SNAPSHOT',
    reasonWindow: null,
    evidence: { primaryRemaining: null, secondaryRemaining: null, effectiveRemaining: null },
    stale: false,
    consecutiveFailures: 0,
    resumePlan: newResumePlan(),
    lastCleanupAt: null,
  };
}

function getState() {
  return readJsonFile(statePath()) ?? newDefaultState();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toWindow(window, name) {
  if (!window || typeof window !== 'object') return null;
  let used = toNumber(getValue(window, 'usedPercent'));
  if (used === null) return null;
  used = Math.max(0, Math.min(100, used));
  return {
    name,
    usedPercent: used,
    remainingPercent: Math.round((100 - used) * 100) / 100,
    windowDurationMins: toNumber(getValue(window, 'windowDurationMins')),
    resetsAt: getValue(window, 'resetsAt'),
  };
}

function enqueueNested(queue, candidate) {
  for (const name of ['structuredContent', 'result', 'data']) {
    const nested = getValue(candidate, name);
    if (nested !== null) queue.push(nested);
  }
  const content = getValue(candidate, 'content');
  if (content !== null && typeof content !== 'string') {
    for (const item of Array.isArray(content) ? content : [content]) {
      const text = getValue(item, 'text');
      if (text !== null) queue.push(text);
    }
  }
}

function findUsagePayload(response) {
  const queue = response === null || response === undefined ? [] : [response];
  for (let seen = 0; queue.length && seen < 30; seen += 1) {
    let candidate = queue.shift();
    if (process.env.USAGE_GUARD_DEBUG === '1') {
      console.error(`[usage-guard] payload-step=${seen + 1} type=${typeof candidate}`);
    }
    if (typeof candidate === 'string') {
      try { candidate = JSON.parse(candidate); } catch { continue; }
    }
    if (!candidate || typeof candidate !== 'object') continue;
    if (getValue(candidate, 'rateLimits') !== null || getValue(candidate, 'rateLimitsByLimitId') !== null) return candidate;
    enqueueNested(queue, candidate);
  }
  return null;
}

function policyForRemaining(remaining) {
  if (remaining < 8) return 'EMERGENCY';
  if (remaining < 15) return 'CRITICAL';
  if (remaining < 30) return 'CONSERVE';
  return 'NORMAL';
}

function reasonCode(policy, window) {
  const prefix = window ? window.toUpperCase() : 'EFFECTIVE';
  if (policy === 'EMERGENCY') return `${prefix}_WINDOW_BELOW_8`;
  if (policy === 'CRITICAL') return `${prefix}_WINDOW_BELOW_15`;
  if (policy === 'CONSERVE') return `${prefix}_WINDOW_BELOW_30`;
  if (policy === 'NORMAL') return 'ALL_WINDOWS_AT_OR_ABOVE_30';
  return 'NO_VALID_WINDOWS';
}

function usageToState(response, previousState) {
  const payload = findUsagePayload(response);
  if (!payload) throw new Error('No usage payload found.');
  let rateLimits = getValue(payload, 'rateLimits');
  const byId = getValue(payload, 'rateLimitsByLimitId');
  if (byId) rateLimits = getValue(byId, 'codex') ?? rateLimits;
  if (!rateLimits) throw new Error('No Codex rate-limit object found.');
  const primary = toWindow(getValue(rateLimits, 'primary'), 'primary');
  const secondary = toWindow(getValue(rateLimits, 'secondary'), 'secondary');
  const valid = [primary, secondary].filter(Boolean);
  if (!valid.length) throw new Error('No valid usage windows found.');
  valid.sort((a, b) => a.remainingPercent - b.remainingPercent);
  const culprit = valid[0];
  const policy = policyForRemaining(culprit.remainingPercent);
  const previousPolicy = String(getValue(previousState, 'currentPolicy') || 'UNKNOWN');
  const now = isoNow();
  const oldChangedAt = getValue(previousState, 'changedAt');
  return {
    schemaVersion: 2,
    lastSuccessfulAt: now,
    windows: { primary, secondary },
    previousPolicy,
    currentPolicy: policy,
    changedAt: previousPolicy !== policy || oldChangedAt === null ? now : oldChangedAt,
    reasonCode: reasonCode(policy, culprit.name),
    reasonWindow: culprit.name,
    evidence: {
      primaryRemaining: primary?.remainingPercent ?? null,
      secondaryRemaining: secondary?.remainingPercent ?? null,
      effectiveRemaining: culprit.remainingPercent,
    },
    stale: false,
    consecutiveFailures: 0,
    resumePlan: getValue(previousState, 'resumePlan'),
    lastCleanupAt: getValue(previousState, 'lastCleanupAt'),
  };
}

function resumePlanForState(state, event, previousPlan, pause = null) {
  const policy = String(getValue(state, 'currentPolicy'));
  const pauseCandidate = Boolean(getValue(pause, 'pauseCandidate'))
    && Boolean(getValue(pause, 'checkpointObserved'))
    && String(getValue(pause, 'pauseReason') ?? '') === 'usage_guard';
  const pauseWindow = pauseCandidate && policy !== 'EMERGENCY' ? String(getValue(pause, 'pauseWindow') ?? '') : '';
  if ((!pauseCandidate && policy !== 'EMERGENCY') || Boolean(getValue(state, 'stale'))) {
    return { plan: newResumePlan(), requestCreated: false };
  }
  const blockingWindows = [];
  const resetValues = [];
  const windows = getValue(state, 'windows');
  for (const name of ['primary', 'secondary']) {
    const window = getValue(windows, name);
    if (pauseWindow && name === pauseWindow) {
      blockingWindows.push(name);
      const reset = toNumber(getValue(pause, 'pauseResetAt')) ?? toNumber(getValue(window, 'resetsAt'));
      if (reset === null) {
        return { plan: newResumePlan({ blockingWindows, status: 'SKIPPED_INVALID_RESET' }), requestCreated: false };
      }
      resetValues.push(Math.floor(reset));
      continue;
    }
    const remaining = toNumber(getValue(window, 'remainingPercent'));
    if (remaining !== null && remaining < 8) {
      blockingWindows.push(name);
      const reset = toNumber(getValue(window, 'resetsAt'));
      if (reset === null) {
        return { plan: newResumePlan({ blockingWindows, status: 'SKIPPED_INVALID_RESET' }), requestCreated: false };
      }
      resetValues.push(Math.floor(reset));
    }
  }
  if (!blockingWindows.length) return { plan: newResumePlan(), requestCreated: false };
  const nowUnix = Math.floor(utcNow().getTime() / 1000);
  const blockingResetAt = Math.max(...resetValues);
  const wakeAt = blockingResetAt + RESUME_SAFETY_SECONDS;
  const waitSeconds = wakeAt - nowUnix;
  if (blockingResetAt <= nowUnix || waitSeconds <= 0) {
    return { plan: newResumePlan({ blockingWindows, blockingResetAt, wakeAt, waitSeconds, status: 'SKIPPED_INVALID_RESET' }), requestCreated: false };
  }
  const scheduleKey = `${safeId(String(getValue(event, 'session_id') ?? ''))}:${blockingWindows.join('+')}:${wakeAt}`;
  if (waitSeconds > RESUME_MAX_WAIT_SECONDS) {
    return { plan: newResumePlan({ blockingWindows, blockingResetAt, wakeAt, waitSeconds, scheduleKey, status: 'SKIPPED_LONG_WAIT' }), requestCreated: false };
  }
  const previousKey = String(getValue(previousPlan, 'scheduleKey') ?? '');
  const previousStatus = String(getValue(previousPlan, 'status') ?? '');
  if (previousKey === scheduleKey && ['REQUESTED', 'SCHEDULED', 'FAILED'].includes(previousStatus)) {
    return {
      plan: newResumePlan({
        eligible: true, blockingWindows, blockingResetAt, wakeAt, waitSeconds, scheduleKey,
        status: previousStatus,
        automationId: getValue(previousPlan, 'automationId'),
        lastError: getValue(previousPlan, 'lastError'),
      }),
      requestCreated: false,
    };
  }
  return {
    plan: newResumePlan({ eligible: true, blockingWindows, blockingResetAt, wakeAt, waitSeconds, scheduleKey, status: 'REQUESTED' }),
    requestCreated: true,
  };
}

function resumeAutomationRrule(wakeAt) {
  const unix = toNumber(wakeAt);
  if (unix === null) return null;
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(unix * 1000));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  if (!values.hour || !values.minute || !values.second) return null;
  return `RRULE:FREQ=DAILY;BYHOUR=${values.hour};BYMINUTE=${values.minute};BYSECOND=${values.second};COUNT=1`;
}

function resumeAutomationInput(plan) {
  const key = String(getValue(plan, 'scheduleKey') ?? '');
  const rrule = resumeAutomationRrule(getValue(plan, 'wakeAt'));
  if (!key || !rrule) return null;
  return {
    mode: 'create',
    kind: 'heartbeat',
    destination: 'thread',
    name: 'Usage Guard resume',
    prompt: `Usage Guard recovery scheduleKey=${key}. Refresh Usage Guard when this heartbeat runs. Continue from the existing checkpoint only after usage leaves EMERGENCY, obey the current policy, stay quiet if still blocked, and pause this heartbeat after its recovery run.`,
    rrule,
    status: 'ACTIVE',
  };
}

function resumePlanContext(state, requestCreated) {
  const plan = getValue(state, 'resumePlan');
  const status = String(getValue(plan, 'status') ?? '');
  if (!status || status === 'NONE') return '';
  const wakeAt = toNumber(getValue(plan, 'wakeAt'));
  const wakeIso = wakeAt === null ? 'unknown' : new Date(wakeAt * 1000).toISOString();
  const key = String(getValue(plan, 'scheduleKey') ?? '');
  if (status === 'SKIPPED_LONG_WAIT') return ` Auto-resume skipped because wakeAt=${wakeIso} is more than six hours away. Save a bounded checkpoint and report manual resume timing.`;
  if (status === 'SKIPPED_INVALID_RESET') return ' Auto-resume skipped because a blocking reset time is missing or invalid. Save a bounded checkpoint and report manual resume guidance.';
  if (status === 'FAILED') return ` Auto-resume scheduling failed for scheduleKey=${key}. Do not retry automatically; preserve a checkpoint and report manual resume guidance.`;
  if (status === 'SCHEDULED') return ` Auto-resume is already scheduled for wakeAt=${wakeIso} scheduleKey=${key}; do not create another heartbeat.`;
  if (requestCreated) {
    const input = resumeAutomationInput(plan);
    return ` AUTO-RESUME ACTION: call ${AUTOMATION_TOOL_NAME} exactly once with this direct create input (do not use suggested_create and do not include DTSTART): ${JSON.stringify(input)}. If the tool is unavailable, report that once and stop after checkpointing.`;
  }
  return ` Auto-resume was already requested for wakeAt=${wakeIso} scheduleKey=${key}; do not request a duplicate.`;
}

function rateLimitQuery() {
  const testPath = process.env.USAGE_GUARD_TEST_RESPONSE_PATH;
  if (testPath && testPath.trim()) {
    const response = readJsonFile(testPath);
    if (!response) return Promise.reject(new Error('Usage Guard test response is unavailable.'));
    return Promise.resolve(response);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* best effort */ }
      if (!child.killed) child.kill();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for account/rateLimits/read.')), QUERY_TIMEOUT_SECONDS * 1000);
    child.on('error', (error) => finish(new Error(`codex app-server is unavailable: ${error.message}`)));
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (getValue(message, 'id') !== 2) continue;
        const error = getValue(message, 'error');
        if (error !== null) return finish(new Error(`account/rateLimits/read failed: ${JSON.stringify(error)}`));
        const result = getValue(message, 'result');
        if (result === null) return finish(new Error('account/rateLimits/read returned no result.'));
        return finish(null, result);
      }
    });
    child.on('exit', code => {
      if (!settled) finish(new Error(`codex app-server exited before returning usage (code=${code}; stderr=${boundedErrorText(stderr)}).`));
    });
    for (const request of [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'usage-guard', version: '0.1.0' }, capabilities: { experimentalApi: true } } },
      { method: 'initialized' },
      { id: 2, method: 'account/rateLimits/read', params: null },
    ]) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function snapshotAgeSeconds(state) {
  const value = getValue(state, 'lastSuccessfulAt');
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? Number.POSITIVE_INFINITY : (utcNow().getTime() - parsed.getTime()) / 1000;
}

function registerUsageFailure(state) {
  state = state ?? newDefaultState();
  state.consecutiveFailures = Math.trunc(toNumber(getValue(state, 'consecutiveFailures')) ?? 0) + 1;
  if (snapshotAgeSeconds(state) <= STALE_SECONDS) {
    state.stale = true;
  } else {
    state.previousPolicy = getValue(state, 'currentPolicy');
    state.currentPolicy = 'UNKNOWN';
    state.reasonCode = 'QUERY_FAILED_NO_CACHE';
    state.reasonWindow = null;
    state.stale = false;
    state.changedAt = isoNow();
  }
  return state;
}

function policySummary(state) {
  if (!state) return 'state=UNKNOWN reason=NO_SNAPSHOT';
  const policy = String(getValue(state, 'currentPolicy') ?? '');
  const reason = String(getValue(state, 'reasonCode') ?? '');
  const effective = getValue(getValue(state, 'evidence'), 'effectiveRemaining');
  let suffix = effective !== null ? ` remaining=${effective}%` : '';
  if (Boolean(getValue(state, 'stale'))) suffix += ' STALE';
  return `state=${policy} reason=${reason}${suffix}`;
}

function contextOutput(eventName, text, systemMessage = null) {
  const output = {};
  if (systemMessage) output.systemMessage = systemMessage;
  output.hookSpecificOutput = { hookEventName: eventName, additionalContext: text };
  return output;
}

function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function toolCommandText(event) {
  const input = getValue(event, 'tool_input');
  const command = getValue(input, 'command');
  return command === null ? JSON.stringify(input) : String(command);
}

function toolClassification(event) {
  const name = String(getValue(event, 'tool_name') ?? '');
  const command = toolCommandText(event);
  const lowerName = name.toLowerCase();
  if (name === USAGE_TOOL_NAME) return { cost: 'LOW', checkpointSafe: true, kind: 'usage' };
  if (name === AUTOMATION_TOOL_NAME) return { cost: 'LOW', checkpointSafe: true, kind: 'resume-automation' };
  if (name === 'Agent' || /spawn_agent|imagegen|image_gen|video/.test(lowerName)) return { cost: 'HIGH', checkpointSafe: false, kind: 'expansion' };
  if (/^mcp__/.test(lowerName)) return { cost: /search|browser|generate|bulk|crawl|scan/.test(lowerName) ? 'HIGH' : 'MEDIUM', checkpointSafe: false, kind: 'mcp' };
  if (['apply_patch', 'Edit', 'Write'].includes(name)) return { cost: 'MEDIUM', checkpointSafe: /(docs[\\/]plan|task_plan\.md|progress\.md|findings\.md|checkpoint|state\.md)/i.test(command), kind: 'edit' };
  if (name === 'Bash' || ['exec_command', 'exec', 'functions.exec'].includes(lowerName)) {
    const statusPattern = ['exec', 'functions.exec'].includes(lowerName)
      ? /\bgit\s+(status|diff)(\s|$)/i
      : /^\s*git\s+(status|diff)(\s|$)/i;
    if (statusPattern.test(command)) return { cost: 'LOW', checkpointSafe: true, kind: 'status' };
    if (['exec', 'functions.exec'].includes(lowerName)
      && /(?:apply_patch|tools\.apply_patch)/i.test(command)
      && /(docs[\\/]plan|task_plan\.md|progress\.md|findings\.md|checkpoint|state\.md)/i.test(command)) {
      return { cost: 'MEDIUM', checkpointSafe: true, kind: 'edit' };
    }
    if (/(--watch|--parallel|--all\b|\s-j\s*\d*|benchmark|dependency|\binstall\b|\brestore\b|\b(build|test)\b.*(--all|--parallel)|rg\s+--files|Get-ChildItem.*-Recurse)/i.test(command)) return { cost: 'HIGH', checkpointSafe: false, kind: 'bulk-shell' };
    return { cost: 'MEDIUM', checkpointSafe: /(Get-Content|type\s+).*(task_plan|progress|findings|checkpoint|state)/i.test(command), kind: 'shell' };
  }
  if (/read|view|get_file|open_file/.test(lowerName)) return { cost: 'LOW', checkpointSafe: /(task_plan|progress|findings|checkpoint|state|git)/i.test(command), kind: 'read' };
  return { cost: 'UNKNOWN', checkpointSafe: false, kind: 'unknown' };
}

function overridePrompt(prompt) {
  return typeof prompt === 'string' && /^\s*usage-guard: override once(?:\s|$)/i.test(prompt);
}

function newTurnRecord(event) {
  return {
    sessionId: String(getValue(event, 'session_id') ?? ''),
    turnId: String(getValue(event, 'turn_id') ?? ''),
    createdAt: isoNow(),
    usageAttempted: false,
    usageChecked: false,
    effectivePolicy: 'UNKNOWN',
    overrideOnce: overridePrompt(String(getValue(event, 'prompt') ?? '')),
    stopContinuationRequested: false,
    resumeScheduleAttempted: false,
    resumeContinuationRequested: false,
    resumeScheduleKey: null,
    pauseCandidate: false,
    pauseReason: null,
    pausePolicy: null,
    pauseCandidateAt: null,
    checkpointObserved: false,
    pauseWindow: null,
    pauseResetAt: null,
  };
}

function getTurnRecord(event) {
  return readJsonFile(turnPath(getValue(event, 'session_id'), getValue(event, 'turn_id')));
}

function saveTurnRecord(event, record) {
  writeJsonAtomic(turnPath(getValue(event, 'session_id'), getValue(event, 'turn_id')), record);
}

async function updateUsageSnapshot(event, turn = null) {
  let state = getState();
  turn = turn ?? getTurnRecord(event) ?? newTurnRecord(event);
  turn.usageAttempted = true;
  try {
    const previousPlan = getValue(state, 'resumePlan');
    state = usageToState(await rateLimitQuery(), state);
    const classification = toolClassification(event);
    const pause = classification.kind === 'resume-automation' && turn.pauseCandidate && turn.checkpointObserved ? turn : null;
    const resume = resumePlanForState(state, event, previousPlan, pause);
    state.resumePlan = resume.plan;
    turn.usageChecked = true;
    turn.effectivePolicy = state.currentPolicy;
    writeJsonAtomic(statePath(), state);
    saveTurnRecord(event, turn);
    return { succeeded: true, state, turn, error: null, resumeRequestCreated: resume.requestCreated };
  } catch (error) {
    console.error(`[usage-guard] quota query failed: ${error.message}`);
    state = registerUsageFailure(state);
    turn.usageChecked = false;
    turn.effectivePolicy = state.currentPolicy;
    writeJsonAtomic(statePath(), state);
    saveTurnRecord(event, turn);
    return { succeeded: false, state, turn, error: error.message, resumeRequestCreated: false };
  }
}

function updatePauseCandidate(turn, state, classification, policy) {
  if (!turn || classification.kind === 'resume-automation') return false;
  let changed = false;
  if (turn.pauseCandidate && turn.checkpointObserved && !classification.checkpointSafe) {
    turn.pauseCandidate = false;
    turn.pauseReason = null;
    turn.pausePolicy = null;
    turn.pauseCandidateAt = null;
    turn.checkpointObserved = false;
    turn.pauseWindow = null;
    turn.pauseResetAt = null;
    changed = true;
  }
  if (policy === 'CRITICAL' || policy === 'EMERGENCY') {
    if (!turn.pauseCandidate) {
      const windows = getValue(state, 'windows');
      const reasonWindow = String(getValue(state, 'reasonWindow') ?? '');
      const candidateWindow = ['primary', 'secondary'].find(name => name === reasonWindow && getValue(windows, name))
        ?? ['primary', 'secondary'].find(name => {
          const remaining = toNumber(getValue(getValue(windows, name), 'remainingPercent'));
          return remaining !== null && remaining < 15;
        })
        ?? null;
      turn.pauseCandidate = true;
      turn.pauseReason = 'usage_guard';
      turn.pausePolicy = policy;
      turn.pauseCandidateAt = isoNow();
      turn.pauseWindow = candidateWindow;
      turn.pauseResetAt = candidateWindow === null ? null : toNumber(getValue(getValue(windows, candidateWindow), 'resetsAt'));
      changed = true;
    }
    if (classification.checkpointSafe && !turn.checkpointObserved) {
      turn.checkpointObserved = true;
      changed = true;
    }
  } else if (turn.pauseCandidate && classification.checkpointSafe && !turn.checkpointObserved) {
    turn.checkpointObserved = true;
    changed = true;
  }
  return changed;
}

function matchingResumeAutomation(event, state) {
  const plan = getValue(state, 'resumePlan');
  if (!Boolean(getValue(plan, 'eligible'))) return false;
  const expected = resumeAutomationInput(plan);
  const input = getValue(event, 'tool_input');
  if (!expected || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const prompt = getValue(input, 'prompt');
  return getValue(input, 'mode') === expected.mode
    && getValue(input, 'kind') === expected.kind
    && getValue(input, 'destination') === expected.destination
    && getValue(input, 'name') === expected.name
    && getValue(input, 'rrule') === expected.rrule
    && getValue(input, 'status') === expected.status
    && typeof prompt === 'string'
    && prompt.includes(String(getValue(plan, 'scheduleKey') ?? ''))
    && /usage[ -]guard/i.test(prompt);
}

function removeExpiredTurns() {
  const turns = path.join(dataRoot(), 'turns');
  if (!fs.existsSync(turns)) return;
  const cutoff = utcNow().getTime() - 7 * 24 * 60 * 60 * 1000;
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try { if (fs.statSync(entryPath).mtimeMs < cutoff) fs.unlinkSync(entryPath); } catch { /* best effort */ }
      }
    }
  };
  try { visit(turns); } catch { /* cleanup is fail-open */ }
}

async function preToolPolicy(event) {
  const classification = toolClassification(event);
  if (classification.kind === 'usage') return {};
  let turn = getTurnRecord(event) ?? newTurnRecord(event);
  const override = Boolean(getValue(turn, 'overrideOnce'));
  const refresh = await updateUsageSnapshot(event, turn);
  turn = refresh.turn;
  let state = refresh.state;
  let policy = String(getValue(state, 'currentPolicy') || 'UNKNOWN');
  if (override) return contextOutput('PreToolUse', `Usage Guard one-turn override is active. Continue deliberately; usage warnings still apply. ${policySummary(state)}`);
  if (updatePauseCandidate(turn, state, classification, policy)) saveTurnRecord(event, turn);
  if (classification.kind === 'resume-automation') {
    const plan = getValue(state, 'resumePlan');
    const planned = Boolean(getValue(plan, 'eligible')) && ['REQUESTED', 'SCHEDULED', 'FAILED'].includes(String(getValue(plan, 'status')));
    if (policy !== 'EMERGENCY' && !planned) return {};
    if (!matchingResumeAutomation(event, state)) return denyOutput('Usage Guard EMERGENCY permits only the heartbeat matching the current recovery schedule key.');
    turn.resumeScheduleAttempted = true;
    turn.resumeScheduleKey = getValue(getValue(state, 'resumePlan'), 'scheduleKey');
    saveTurnRecord(event, turn);
    return contextOutput('PreToolUse', 'Usage Guard permits this matching bounded auto-resume heartbeat operation.');
  }
  if (policy === 'UNKNOWN') return contextOutput('PreToolUse', 'Usage state is UNKNOWN; fail-open is active. Continue cautiously and preserve a checkpoint after repeated failures.', 'Usage Guard could not read quota and is failing open.');
  if (policy === 'NORMAL') return {};
  if (policy === 'CONSERVE') {
    if (classification.kind === 'expansion') return denyOutput('Usage Guard CONSERVE blocks new subagents and generated-media expansion.');
    return contextOutput('PreToolUse', `Usage Guard CONSERVE: ${policySummary(state)}. Keep scope narrow.`);
  }
  if (policy === 'CRITICAL') {
    if (classification.cost === 'HIGH') return denyOutput(`Usage Guard CRITICAL blocks high-cost work: ${policySummary(state)}.`);
    return contextOutput('PreToolUse', `Usage Guard CRITICAL: finish only the smallest necessary step; ${policySummary(state)}.`);
  }
  if (policy === 'EMERGENCY') {
    if (!classification.checkpointSafe) return denyOutput(`Usage Guard EMERGENCY allows only bounded checkpoint, status, and reporting operations: ${policySummary(state)}.`);
    return contextOutput('PreToolUse', 'Usage Guard EMERGENCY: this bounded checkpoint operation is allowed; do not expand its scope.');
  }
  return {};
}

function usagePostTool(event) {
  let state = getState();
  const turn = getTurnRecord(event) ?? newTurnRecord(event);
  turn.usageAttempted = true;
  try {
    const previousPlan = getValue(state, 'resumePlan');
    state = usageToState(getValue(event, 'tool_response'), state);
    const resume = resumePlanForState(state, event, previousPlan);
    state.resumePlan = resume.plan;
    turn.usageChecked = true;
    turn.effectivePolicy = state.currentPolicy;
    writeJsonAtomic(statePath(), state);
    saveTurnRecord(event, turn);
    return contextOutput('PostToolUse', `Usage Guard updated: ${policySummary(state)}. This is a tool policy, not a work-capacity estimate.${resumePlanContext(state, resume.requestCreated)}`);
  } catch (error) {
    console.error(`[usage-guard] quota processing failed: ${error.message}`);
    state = registerUsageFailure(state);
    turn.usageChecked = false;
    turn.effectivePolicy = state.currentPolicy;
    writeJsonAtomic(statePath(), state);
    saveTurnRecord(event, turn);
    const checkpoint = Number(getValue(state, 'consecutiveFailures')) >= 3 ? ' Create a bounded recovery checkpoint before substantial work.' : '';
    return contextOutput('PostToolUse', `Usage Guard could not parse quota; fail-open is active. ${policySummary(state)}.${checkpoint}`, 'Usage Guard quota query failed; work remains available.');
  }
}

function findAutomationResult(response) {
  const queue = response === null || response === undefined ? [] : [response];
  for (let seen = 0; queue.length && seen < 40; seen += 1) {
    let candidate = queue.shift();
    if (typeof candidate === 'string') {
      try { candidate = JSON.parse(candidate); } catch { continue; }
    }
    if (!candidate || typeof candidate !== 'object') continue;
    const automationId = getValue(candidate, 'automationId');
    const status = String(getValue(candidate, 'status') ?? '');
    if (automationId !== null || /^(created|updated|active|scheduled|success|ok)$/i.test(status)) return candidate;
    for (const name of ['structuredContent', 'result', 'data', 'output']) {
      const nested = getValue(candidate, name);
      if (nested !== null) queue.push(nested);
    }
    const content = getValue(candidate, 'content');
    if (content !== null && typeof content !== 'string') {
      for (const item of Array.isArray(content) ? content : [content]) {
        const text = getValue(item, 'text');
        if (text !== null) queue.push(text);
      }
    }
  }
  return null;
}

function boundedErrorText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || 'Unknown automation error.').slice(0, 240);
}

function automationPostTool(event) {
  const state = getState();
  const turn = getTurnRecord(event) ?? newTurnRecord(event);
  turn.resumeScheduleAttempted = true;
  const plan = getValue(state, 'resumePlan') ?? newResumePlan();
  try {
    const response = getValue(event, 'tool_response');
    if (getValue(response, 'isError') === true) throw new Error('Automation tool reported an error.');
    const result = findAutomationResult(response);
    if (!result) throw new Error('Automation tool returned no creation or update result.');
    plan.status = 'SCHEDULED';
    plan.automationId = getValue(result, 'automationId') ?? getValue(result, 'id');
    plan.lastError = null;
    plan.updatedAt = isoNow();
    state.resumePlan = plan;
    writeJsonAtomic(statePath(), state);
    saveTurnRecord(event, turn);
    return contextOutput('PostToolUse', `Usage Guard auto-resume scheduled for scheduleKey=${String(getValue(plan, 'scheduleKey') ?? '')}. Do not create another heartbeat.`);
  } catch (error) {
    plan.status = 'FAILED';
    plan.lastError = boundedErrorText(error.message);
    plan.updatedAt = isoNow();
    state.resumePlan = plan;
    writeJsonAtomic(statePath(), state);
    saveTurnRecord(event, turn);
    return contextOutput('PostToolUse', 'Usage Guard auto-resume scheduling failed. Preserve a bounded checkpoint and use manual resume; do not retry automatically.', 'Usage Guard could not schedule auto-resume.');
  }
}

async function invokeHookEvent(event) {
  const eventName = String(getValue(event, 'hook_event_name') ?? '');
  if (eventName === 'SessionStart') {
    removeExpiredTurns();
    return contextOutput('SessionStart', `Usage Guard is active and queries Codex usage automatically on each user turn and before every tool call. ${policySummary(getState())}.`);
  }
  if (eventName === 'UserPromptSubmit') {
    const turn = newTurnRecord(event);
    const refresh = await updateUsageSnapshot(event, turn);
    const override = turn.overrideOnce ? ' One-turn override is bound to this session and turn.' : '';
    if (refresh.succeeded) return contextOutput('UserPromptSubmit', `Usage Guard checked automatically: ${policySummary(refresh.state)}. Treat this as tool policy, not a work-capacity estimate.${resumePlanContext(refresh.state, refresh.resumeRequestCreated)}${override}`);
    const checkpoint = Number(getValue(refresh.state, 'consecutiveFailures')) >= 3 ? ' Create a bounded recovery checkpoint before substantial work.' : '';
    return contextOutput('UserPromptSubmit', `Usage Guard query failed; fail-open is active. ${policySummary(refresh.state)}.${checkpoint}${override}`, 'Usage Guard could not read quota; work remains available.');
  }
  if (eventName === 'PreToolUse') return preToolPolicy(event);
  if (eventName === 'PostToolUse') return String(getValue(event, 'tool_name')) === AUTOMATION_TOOL_NAME ? automationPostTool(event) : usagePostTool(event);
  if (eventName === 'SubagentStart') return contextOutput('SubagentStart', `Usage Guard applies inside this subagent. ${policySummary(getState())}. Converge when the assigned task is complete.`);
  if (eventName === 'PreCompact') return { systemMessage: `Usage Guard state preserved: ${policySummary(getState())}.` };
  if (eventName === 'PostCompact') return { systemMessage: `Usage Guard state restored: ${policySummary(getState())}.` };
  if (eventName === 'Stop') {
    if (Boolean(getValue(event, 'stop_hook_active'))) return {};
    let state = getState();
    let plan = getValue(state, 'resumePlan');
    const turn = getTurnRecord(event);
    let requested = Boolean(getValue(plan, 'eligible')) && String(getValue(plan, 'status')) === 'REQUESTED';
    if (!requested && turn && Boolean(getValue(turn, 'pauseCandidate')) && Boolean(getValue(turn, 'checkpointObserved'))) {
      const resume = resumePlanForState(state, event, plan, turn);
      state.resumePlan = resume.plan;
      plan = resume.plan;
      requested = Boolean(getValue(plan, 'eligible')) && String(getValue(plan, 'status')) === 'REQUESTED';
      writeJsonAtomic(statePath(), state);
    }
    const wakeAt = toNumber(getValue(plan, 'wakeAt'));
    const nowUnix = Math.floor(utcNow().getTime() / 1000);
    if (requested && (wakeAt === null || wakeAt <= nowUnix)) {
      plan.eligible = false;
      plan.status = 'SKIPPED_INVALID_RESET';
      plan.lastError = 'Recovery wake time expired before scheduling.';
      plan.updatedAt = isoNow();
      state.resumePlan = plan;
      writeJsonAtomic(statePath(), state);
      return {};
    }
    if (!turn) return {};
    if (requested && !Boolean(getValue(turn, 'resumeScheduleAttempted')) && !Boolean(getValue(turn, 'resumeContinuationRequested'))) {
      turn.resumeContinuationRequested = true;
      saveTurnRecord(event, turn);
      const wakeIso = new Date(wakeAt * 1000).toISOString();
      const key = String(getValue(plan, 'scheduleKey') ?? '');
      const input = resumeAutomationInput(plan);
      return { decision: 'block', reason: `Attempt the one Usage Guard same-thread heartbeat now with ${AUTOMATION_TOOL_NAME} using this direct create input (do not use suggested_create and do not include DTSTART): ${JSON.stringify(input)} for wakeAt=${wakeIso} scheduleKey=${key}. If the tool is unavailable, report that once, preserve the checkpoint, and stop; do not retry.` };
    }
    return {};
  }
  if (eventName === 'SessionEnd') {
    removeExpiredTurns();
    return {};
  }
  return {};
}

async function main() {
  try {
    if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 or newer is required.');
    const raw = await new Promise((resolve, reject) => {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => resolve(input));
      process.stdin.on('error', reject);
    });
    const result = raw.trim() ? await invokeHookEvent(JSON.parse(raw)) : {};
    process.stdout.write(`${JSON.stringify(result ?? {})}\n`);
  } catch (error) {
    console.error(`[usage-guard] ${error.message}`);
    process.stdout.write(`${JSON.stringify({ systemMessage: 'Usage Guard failed safely; quota enforcement is disabled for this event.' })}\n`);
  }
}

module.exports = {
  constants: { USAGE_TOOL_NAME, AUTOMATION_TOOL_NAME, FRESH_SECONDS, STALE_SECONDS, RESUME_SAFETY_SECONDS, RESUME_MAX_WAIT_SECONDS, LOCK_STALE_MS },
  utcNow, safeId, dataRoot, statePath, turnPath, readJsonFile, writeJsonAtomic,
  newResumePlan, newDefaultState, getState, toNumber, toWindow, findUsagePayload,
  policyForRemaining, reasonCode, usageToState, resumePlanForState, resumeAutomationRrule, resumeAutomationInput, resumePlanContext,
  rateLimitQuery, snapshotAgeSeconds, registerUsageFailure, policySummary, contextOutput,
  denyOutput, toolCommandText, toolClassification, overridePrompt, newTurnRecord,
  getTurnRecord, saveTurnRecord, updateUsageSnapshot, matchingResumeAutomation,
  removeExpiredTurns, preToolPolicy, usagePostTool, findAutomationResult,
  boundedErrorText, automationPostTool, invokeHookEvent, main,
};

if (require.main === module) main();
