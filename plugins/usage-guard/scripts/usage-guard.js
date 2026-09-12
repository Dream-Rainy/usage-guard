'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const USAGE_TOOL_NAME = 'mcp__codex_app__get_usage_limits';
const AUTOMATION_TOOL_NAME = 'mcp__codex_app__automation_update';
const FRESH_SECONDS = 120;
const STALE_SECONDS = 300;
const QUERY_TIMEOUT_SECONDS = 10;
const RESUME_SAFETY_SECONDS = 180;
const RESUME_MAX_WAIT_SECONDS = 21600;
const LOCK_STALE_MS = 30_000;
const CHECKPOINT_RELATIVE_PATH = path.join('docs', 'plan', 'usage-guard-checkpoint.json');

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

function continuationPath(sessionId) {
  return path.join(dataRoot(), 'sessions', `${safeId(String(sessionId ?? ''))}.json`);
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
    cycleId: 0,
    resumeMode: 'continue',
    status: 'NONE',
    automationId: null,
    lastError: null,
    updatedAt: isoNow(),
    ...overrides,
  };
}

function newContinuationRecord(event) {
  return {
    schemaVersion: 1,
    sessionId: String(getValue(event, 'session_id') ?? ''),
    taskStatus: 'RUNNING',
    continuationEnabled: true,
    pauseReason: null,
    checkpointPath: null,
    checkpointRevision: null,
    checkpointObservedAt: null,
    pauseWindow: null,
    pauseResetAt: null,
    resumeMode: 'continue',
    cycleId: 0,
    resumePlan: newResumePlan(),
    lastError: null,
    updatedAt: isoNow(),
  };
}

function getContinuationRecord(event) {
  return readJsonFile(continuationPath(getValue(event, 'session_id'))) ?? newContinuationRecord(event);
}

function saveContinuationRecord(event, record) {
  record.updatedAt = isoNow();
  writeJsonAtomic(continuationPath(getValue(event, 'session_id')), record);
}

function activePlan(plan) {
  return Boolean(getValue(plan, 'eligible')) && ['REQUESTED', 'SCHEDULED', 'FAILED'].includes(String(getValue(plan, 'status') ?? ''));
}

function terminalTaskStatus(status) {
  return ['COMPLETED', 'CANCELLED', 'WAITING_USER', 'WEEKLY_STOPPED'].includes(String(status ?? ''));
}

function continuationPlan(record) {
  const plan = getValue(record, 'resumePlan');
  return plan && typeof plan === 'object' ? plan : newResumePlan();
}

function workspaceRoot(event) {
  const cwd = String(getValue(event, 'cwd') ?? '').trim();
  return path.resolve(cwd || process.cwd());
}

function checkpointMarkerPath(event) {
  return path.resolve(workspaceRoot(event), CHECKPOINT_RELATIVE_PATH);
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readCheckpointMarker(event) {
  const markerPath = checkpointMarkerPath(event);
  let raw;
  try { raw = fs.readFileSync(markerPath, 'utf8'); } catch { return null; }
  let marker;
  try { marker = JSON.parse(raw); } catch { return null; }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const sessionId = String(getValue(event, 'session_id') ?? '');
  if (!sessionId || String(getValue(marker, 'sessionId') ?? '') !== sessionId) return null;
  const taskStatus = String(getValue(marker, 'taskStatus') ?? '');
  if (!['RUNNING', 'PAUSED_QUOTA', 'COMPLETED', 'CANCELLED', 'WAITING_USER', 'WEEKLY_STOPPED'].includes(taskStatus)) return null;
  const checkpointPath = String(getValue(marker, 'checkpointPath') ?? '').trim();
  const planRoot = path.resolve(workspaceRoot(event), 'docs', 'plan');
  const resolvedCheckpoint = path.resolve(workspaceRoot(event), checkpointPath);
  if (!checkpointPath || !isPathInside(planRoot, resolvedCheckpoint)) return null;
  try { if (!fs.statSync(resolvedCheckpoint).isFile()) return null; } catch { return null; }
  const revision = String(getValue(marker, 'revision') ?? getValue(marker, 'checkpointRevision') ?? '').trim();
  if (!revision) return null;
  if (taskStatus === 'PAUSED_QUOTA') {
    if (!['short_window', 'weekly_budget', 'plugin_pause'].includes(String(getValue(marker, 'pauseReason') ?? ''))) return null;
    if (!String(getValue(marker, 'nextStep') ?? '').trim()) return null;
  }
  return {
    marker,
    checkpointPath,
    checkpointRevision: createHash('sha256').update(raw).digest('hex').slice(0, 16),
  };
}

function newDefaultState() {
  return {
    schemaVersion: 2,
    lastSuccessfulAt: null,
    windows: { primary: null, secondary: null },
    windowRoles: { short: null, weekly: null },
    windowRoleErrors: [],
    previousPolicy: null,
    previousAction: null,
    currentPolicy: 'UNKNOWN',
    shortPolicy: 'UNKNOWN',
    weeklyPolicy: 'UNKNOWN',
    policyAction: 'UNKNOWN',
    changedAt: null,
    reasonCode: 'NO_SNAPSHOT',
    reasonWindow: null,
    evidence: {
      primaryRemaining: null,
      secondaryRemaining: null,
      effectiveRemaining: null,
      shortRemaining: null,
      weeklyRemaining: null,
    },
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

function windowRole(duration) {
  const minutes = toNumber(duration);
  if (minutes === 300) return 'short';
  if (minutes === 10080) return 'weekly';
  return null;
}

function toWindow(window, name) {
  if (!window || typeof window !== 'object') return null;
  let used = toNumber(getValue(window, 'usedPercent'));
  if (used === null) return null;
  used = Math.max(0, Math.min(100, used));
  const duration = toNumber(getValue(window, 'windowDurationMins'));
  return {
    name,
    usedPercent: used,
    remainingPercent: Math.round((100 - used) * 100) / 100,
    windowDurationMins: duration,
    role: windowRole(duration),
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

function weeklyPolicyForRemaining(remaining) {
  if (remaining < 5) return 'STOP';
  if (remaining < 8) return 'FINALIZE';
  if (remaining < 15) return 'LOW';
  return 'HEALTHY';
}

function policySeverity(policy) {
  return { NORMAL: 0, HEALTHY: 0, CONSERVE: 1, LOW: 1, CRITICAL: 2, FINALIZE: 2, EMERGENCY: 3, STOP: 4 }[policy] ?? -1;
}

function combinedPolicy(shortPolicy, weeklyPolicy, fallback = 'UNKNOWN') {
  const weeklyEquivalent = { HEALTHY: 'NORMAL', LOW: 'CONSERVE', FINALIZE: 'CRITICAL', STOP: 'EMERGENCY' }[weeklyPolicy];
  return [shortPolicy, weeklyEquivalent, fallback]
    .filter(policy => policy && policy !== 'UNKNOWN')
    .sort((a, b) => policySeverity(b) - policySeverity(a))[0] ?? 'UNKNOWN';
}

function policyAction(shortPolicy, weeklyPolicy, roleErrors = []) {
  if (roleErrors.length) return 'UNKNOWN_WINDOW_ROLE';
  if (weeklyPolicy === 'STOP') return 'WEEKLY_STOP';
  if (shortPolicy === 'EMERGENCY') return 'SHORT_SUSPEND';
  if (weeklyPolicy === 'FINALIZE') return 'WEEKLY_FINALIZE';
  if (shortPolicy === 'CRITICAL') return 'SHORT_CRITICAL';
  if (weeklyPolicy === 'LOW') return 'WEEKLY_LOW';
  if (shortPolicy === 'CONSERVE') return 'SHORT_CONSERVE';
  if (shortPolicy === 'NORMAL' && weeklyPolicy === 'HEALTHY') return 'RUN';
  return 'UNKNOWN';
}

function identifyWindowRoles(windows) {
  const roles = { short: null, weekly: null };
  const errors = [];
  for (const name of ['primary', 'secondary']) {
    const role = String(getValue(getValue(windows, name), 'role') ?? '');
    if (!role) continue;
    if (roles[role]) errors.push(`DUPLICATE_${role.toUpperCase()}_WINDOW`);
    else if (Object.prototype.hasOwnProperty.call(roles, role)) roles[role] = name;
  }
  for (const role of ['short', 'weekly']) if (!roles[role]) errors.push(`MISSING_${role.toUpperCase()}_WINDOW`);
  return { roles, errors };
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
  const windows = { primary, secondary };
  const valid = [primary, secondary].filter(Boolean);
  if (!valid.length) throw new Error('No valid usage windows found.');
  valid.sort((a, b) => a.remainingPercent - b.remainingPercent);
  const culprit = valid[0];
  const roleInfo = identifyWindowRoles(windows);
  const shortWindow = roleInfo.roles.short ? getValue(windows, roleInfo.roles.short) : null;
  const weeklyWindow = roleInfo.roles.weekly ? getValue(windows, roleInfo.roles.weekly) : null;
  const shortPolicy = shortWindow ? policyForRemaining(shortWindow.remainingPercent) : 'UNKNOWN';
  const weeklyPolicy = weeklyWindow ? weeklyPolicyForRemaining(weeklyWindow.remainingPercent) : 'UNKNOWN';
  const fallbackPolicy = policyForRemaining(culprit.remainingPercent);
  const policy = combinedPolicy(shortPolicy, weeklyPolicy, fallbackPolicy);
  const action = policyAction(shortPolicy, weeklyPolicy, roleInfo.errors);
  const previousPolicy = String(getValue(previousState, 'currentPolicy') || 'UNKNOWN');
  const previousAction = String(getValue(previousState, 'policyAction') || 'UNKNOWN');
  const now = isoNow();
  const oldChangedAt = getValue(previousState, 'changedAt');
  return {
    schemaVersion: 2,
    lastSuccessfulAt: now,
    windows,
    windowRoles: roleInfo.roles,
    windowRoleErrors: roleInfo.errors,
    previousPolicy,
    previousAction,
    currentPolicy: policy,
    shortPolicy,
    weeklyPolicy,
    policyAction: action,
    changedAt: previousPolicy !== policy || previousAction !== action || oldChangedAt === null ? now : oldChangedAt,
    reasonCode: roleInfo.errors.length ? roleInfo.errors[0] : reasonCode(policy, culprit.name),
    reasonWindow: culprit.name,
    reasonRole: culprit.role,
    evidence: {
      primaryRemaining: primary?.remainingPercent ?? null,
      secondaryRemaining: secondary?.remainingPercent ?? null,
      effectiveRemaining: culprit.remainingPercent,
      shortRemaining: shortWindow?.remainingPercent ?? null,
      weeklyRemaining: weeklyWindow?.remainingPercent ?? null,
    },
    stale: false,
    consecutiveFailures: 0,
    resumePlan: getValue(previousState, 'resumePlan'),
    lastCleanupAt: getValue(previousState, 'lastCleanupAt'),
  };
}

function resumePlanForState(state, event, previousPlan, pause = null, continuation = null) {
  const previous = previousPlan && typeof previousPlan === 'object' ? previousPlan : newResumePlan();
  const taskStatus = String(getValue(continuation, 'taskStatus') ?? '');
  if (terminalTaskStatus(taskStatus)) {
    const status = taskStatus === 'WEEKLY_STOPPED' ? 'WEEKLY_STOPPED' : 'CANCELLED';
    return { plan: activePlan(previous) ? newResumePlan({ status }) : previous, requestCreated: false };
  }
  const weekly = String(getValue(state, 'weeklyPolicy') ?? 'UNKNOWN');
  const short = String(getValue(state, 'shortPolicy') ?? 'UNKNOWN');
  const roleErrors = Array.isArray(getValue(state, 'windowRoleErrors')) ? getValue(state, 'windowRoleErrors') : [];
  if (weekly === 'STOP') return { plan: newResumePlan({ status: 'WEEKLY_STOPPED', resumeMode: 'finalize_only', lastError: 'Weekly quota is below 5%; heartbeat recovery is disabled.' }), requestCreated: false };
  if (Boolean(getValue(state, 'stale'))) return { plan: activePlan(previous) ? previous : newResumePlan(), requestCreated: false };
  if (roleErrors.length) return { plan: activePlan(previous) ? previous : newResumePlan({ status: 'SKIPPED_INVALID_WINDOW_ROLE', lastError: roleErrors.join(',') }), requestCreated: false };

  const explicitPause = String(getValue(continuation, 'taskStatus') ?? '') === 'PAUSED_QUOTA'
    && Boolean(getValue(continuation, 'checkpointRevision'))
    && Boolean(getValue(continuation, 'checkpointPath'));
  const legacyPause = Boolean(getValue(pause, 'pauseCandidate'))
    && Boolean(getValue(pause, 'checkpointObserved'))
    && String(getValue(pause, 'pauseReason') ?? '') === 'usage_guard';
  const pauseSource = explicitPause ? continuation : legacyPause ? pause : null;
  const pauseReason = String(getValue(pauseSource, 'pauseReason') ?? '');
  if (pauseReason === 'weekly_budget') {
    return { plan: newResumePlan({ status: weekly === 'STOP' ? 'WEEKLY_STOPPED' : 'WEEKLY_FINALIZE', resumeMode: 'finalize_only' }), requestCreated: false };
  }
  const shortPause = pauseReason === 'short_window' || pauseReason === 'plugin_pause' || (legacyPause && pauseReason === 'usage_guard');
  const shouldSchedule = short === 'EMERGENCY' || shortPause;
  if (weekly === 'FINALIZE' && !shouldSchedule) return { plan: newResumePlan({ status: 'WEEKLY_FINALIZE', resumeMode: 'finalize_only' }), requestCreated: false };
  if (!shouldSchedule) return { plan: activePlan(previous) ? previous : newResumePlan(), requestCreated: false };

  const windows = getValue(state, 'windows') ?? {};
  const shortName = String(getValue(pauseSource, 'pauseWindow') ?? getValue(getValue(state, 'windowRoles'), 'short') ?? '');
  const shortWindow = getValue(windows, shortName);
  if (!shortName || !shortWindow) return { plan: activePlan(previous) ? previous : newResumePlan({ status: 'SKIPPED_INVALID_WINDOW_ROLE' }), requestCreated: false };
  const blockingWindows = [shortName];
  const resetValues = [];
  const reset = toNumber(getValue(pauseSource, 'pauseResetAt')) ?? toNumber(getValue(shortWindow, 'resetsAt'));
  if (reset === null) return { plan: newResumePlan({ blockingWindows, status: 'SKIPPED_INVALID_RESET' }), requestCreated: false };
  resetValues.push(Math.floor(reset));
  const nowUnix = Math.floor(utcNow().getTime() / 1000);
  const blockingResetAt = Math.max(...resetValues);
  const wakeAt = blockingResetAt + RESUME_SAFETY_SECONDS;
  const waitSeconds = wakeAt - nowUnix;
  if (blockingResetAt <= nowUnix || waitSeconds <= 0) {
    return { plan: newResumePlan({ blockingWindows, blockingResetAt, wakeAt, waitSeconds, status: 'SKIPPED_INVALID_RESET' }), requestCreated: false };
  }
  const priorKey = String(getValue(previous, 'scheduleKey') ?? '');
  const sameWindowAndWake = priorKey && toNumber(getValue(previous, 'wakeAt')) === wakeAt
    && JSON.stringify(getValue(previous, 'blockingWindows') ?? []) === JSON.stringify(blockingWindows);
  const cycleId = sameWindowAndWake
    ? (toNumber(getValue(previous, 'cycleId')) ?? 1)
    : (Math.max(toNumber(getValue(previous, 'cycleId')) ?? 0, toNumber(getValue(continuation, 'cycleId')) ?? 0) + 1);
  const scheduleKey = sameWindowAndWake ? priorKey : `${safeId(String(getValue(event, 'session_id') ?? ''))}:${blockingWindows.join('+')}:${wakeAt}:c${cycleId}`;
  if (waitSeconds > RESUME_MAX_WAIT_SECONDS) {
    return { plan: newResumePlan({ blockingWindows, blockingResetAt, wakeAt, waitSeconds, scheduleKey, cycleId, resumeMode: weekly === 'FINALIZE' ? 'finalize_only' : getValue(pauseSource, 'resumeMode') ?? 'continue', status: 'SKIPPED_LONG_WAIT' }), requestCreated: false };
  }
  const previousStatus = String(getValue(previous, 'status') ?? '');
  if (sameWindowAndWake && ['REQUESTED', 'SCHEDULED', 'FAILED'].includes(previousStatus)) {
    return {
      plan: newResumePlan({
        eligible: true, blockingWindows, blockingResetAt, wakeAt, waitSeconds, scheduleKey, cycleId,
        resumeMode: weekly === 'FINALIZE' ? 'finalize_only' : getValue(previous, 'resumeMode') ?? getValue(pauseSource, 'resumeMode') ?? 'continue',
        status: previousStatus,
        automationId: getValue(previous, 'automationId'),
        lastError: getValue(previous, 'lastError'),
      }),
      requestCreated: false,
    };
  }
  return {
    plan: newResumePlan({ eligible: true, blockingWindows, blockingResetAt, wakeAt, waitSeconds, scheduleKey, cycleId, resumeMode: weekly === 'FINALIZE' ? 'finalize_only' : getValue(pauseSource, 'resumeMode') ?? 'continue', status: 'REQUESTED' }),
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
    prompt: `Usage Guard recovery scheduleKey=${key} cycleId=${String(getValue(plan, 'cycleId') ?? 0)} resumeMode=${String(getValue(plan, 'resumeMode') ?? 'continue')}. Refresh Usage Guard when this heartbeat runs. Continue from the existing checkpoint only after the short window has reset and the weekly policy permits it; obey the current policy, stay quiet if still blocked, and pause this heartbeat after its recovery run.`,
    rrule,
    status: 'ACTIVE',
  };
}

function resumePlanContext(state, requestCreated, planOverride = null) {
  const plan = planOverride ?? getValue(state, 'resumePlan');
  const status = String(getValue(plan, 'status') ?? '');
  if (!status || status === 'NONE') return '';
  const wakeAt = toNumber(getValue(plan, 'wakeAt'));
  const wakeIso = wakeAt === null ? 'unknown' : new Date(wakeAt * 1000).toISOString();
  const key = String(getValue(plan, 'scheduleKey') ?? '');
  if (status === 'CONSUMED') return '';
  if (status === 'WEEKLY_STOPPED') return ' Weekly quota is below 5%; no heartbeat will be created. Finish the final handoff and wait for the weekly reset.';
  if (status === 'WEEKLY_FINALIZE') return ' Weekly quota is in finalization range; finish the current coherent unit and leave a complete handoff. Do not wait on a short-window heartbeat.';
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
    state.previousAction = getValue(state, 'policyAction');
    state.currentPolicy = 'UNKNOWN';
    state.shortPolicy = 'UNKNOWN';
    state.weeklyPolicy = 'UNKNOWN';
    state.policyAction = 'UNKNOWN';
    state.windowRoles = getValue(state, 'windowRoles') ?? { short: null, weekly: null };
    state.windowRoleErrors = getValue(state, 'windowRoleErrors') ?? [];
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
  const action = String(getValue(state, 'policyAction') ?? '');
  const short = getValue(getValue(state, 'evidence'), 'shortRemaining');
  const weekly = getValue(getValue(state, 'evidence'), 'weeklyRemaining');
  let suffix = effective !== null ? ` remaining=${effective}%` : '';
  if (short !== null && weekly !== null) suffix += ` short=${short}% weekly=${weekly}%`;
  const shortPolicy = String(getValue(state, 'shortPolicy') ?? '');
  const weeklyPolicy = String(getValue(state, 'weeklyPolicy') ?? '');
  if (shortPolicy && weeklyPolicy && shortPolicy !== 'UNKNOWN' && weeklyPolicy !== 'UNKNOWN') suffix += ` shortPolicy=${shortPolicy} weeklyPolicy=${weeklyPolicy}`;
  if (action && action !== 'UNKNOWN') suffix += ` action=${action}`;
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
    policyAction: 'UNKNOWN',
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
    checkpointPath: null,
    checkpointRevision: null,
    checkpointRequestIssued: false,
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

function recoveryScheduleKey(prompt) {
  const match = String(prompt ?? '').match(/Usage Guard recovery scheduleKey=([^\s.]+)/i);
  return match ? match[1] : null;
}

function beginUserPrompt(event) {
  const record = getContinuationRecord(event);
  const key = recoveryScheduleKey(getValue(event, 'prompt'));
  const plan = continuationPlan(record);
  if (key && activePlan(plan) && key === String(getValue(plan, 'scheduleKey') ?? '')) {
    record.taskStatus = 'RUNNING';
    record.continuationEnabled = true;
    record.pauseReason = null;
    record.resumePlan = { ...plan, eligible: false, status: 'CONSUMED', consumedAt: isoNow(), updatedAt: isoNow() };
    saveContinuationRecord(event, record);
    return record;
  }
  if (terminalTaskStatus(record.taskStatus) || record.taskStatus === 'PAUSED_QUOTA') {
    record.taskStatus = 'RUNNING';
    record.continuationEnabled = true;
    record.pauseReason = null;
    record.resumePlan = newResumePlan({ status: 'CONSUMED', cycleId: toNumber(getValue(record, 'cycleId')) ?? 0 });
    saveContinuationRecord(event, record);
  }
  return record;
}

function checkpointPostTool(event) {
  if (getValue(getValue(event, 'tool_response'), 'isError') === true) return {};
  const verified = readCheckpointMarker(event);
  if (!verified) return {};
  const marker = verified.marker;
  const state = getState();
  const record = getContinuationRecord(event);
  if (String(getValue(record, 'checkpointRevision') ?? '') === verified.checkpointRevision
    && String(getValue(record, 'checkpointPath') ?? '') === verified.checkpointPath) return {};
  const turn = getTurnRecord(event) ?? newTurnRecord(event);
  const taskStatus = String(getValue(marker, 'taskStatus'));
  record.taskStatus = taskStatus;
  record.continuationEnabled = !terminalTaskStatus(taskStatus);
  record.checkpointPath = verified.checkpointPath;
  record.checkpointRevision = verified.checkpointRevision;
  record.checkpointObservedAt = isoNow();
  record.lastError = null;
  if (taskStatus === 'PAUSED_QUOTA') {
    record.pauseReason = String(getValue(marker, 'pauseReason'));
    record.resumeMode = ['continue', 'finalize_only'].includes(String(getValue(marker, 'resumeMode') ?? ''))
      ? String(getValue(marker, 'resumeMode')) : 'continue';
    record.pauseWindow = String(getValue(marker, 'pauseWindow') ?? '') || (record.pauseReason === 'weekly_budget'
      ? String(getValue(getValue(state, 'windowRoles'), 'weekly') ?? '')
      : String(getValue(getValue(state, 'windowRoles'), 'short') ?? ''));
    record.pauseResetAt = toNumber(getValue(marker, 'pauseResetAt'))
      ?? toNumber(getValue(getValue(getValue(state, 'windows'), record.pauseWindow), 'resetsAt'));
    record.resumePlan = continuationPlan(record);
    turn.pauseCandidate = true;
    turn.pauseReason = 'usage_guard';
    turn.pausePolicy = getValue(state, 'currentPolicy');
    turn.pauseWindow = record.pauseWindow;
    turn.pauseResetAt = record.pauseResetAt;
  } else if (terminalTaskStatus(taskStatus)) {
    record.pauseReason = null;
    record.pauseWindow = null;
    record.pauseResetAt = null;
    record.resumePlan = newResumePlan({ status: taskStatus === 'WEEKLY_STOPPED' ? 'WEEKLY_STOPPED' : 'CANCELLED' });
  }
  turn.checkpointObserved = true;
  turn.checkpointRequestIssued = true;
  turn.policyAction = state.policyAction;
  turn.checkpointPath = verified.checkpointPath;
  turn.checkpointRevision = verified.checkpointRevision;
  state.resumePlan = record.resumePlan;
  writeJsonAtomic(statePath(), state);
  saveContinuationRecord(event, record);
  saveTurnRecord(event, turn);
  const label = taskStatus === 'PAUSED_QUOTA' ? ` pauseReason=${record.pauseReason}` : '';
  return contextOutput('PostToolUse', `Usage Guard checkpoint registered${label}; continuation state is durable.`);
}

async function updateUsageSnapshot(event, turn = null) {
  let state = getState();
  turn = turn ?? getTurnRecord(event) ?? newTurnRecord(event);
  const continuation = getContinuationRecord(event);
  turn.usageAttempted = true;
  try {
    const previousPlan = continuationPlan(continuation);
    state = usageToState(await rateLimitQuery(), state);
    const classification = toolClassification(event);
    const pause = continuation.taskStatus === 'PAUSED_QUOTA'
      ? continuation
      : (turn.pauseCandidate && turn.checkpointObserved ? turn : null);
    const shouldPlan = continuation.taskStatus === 'PAUSED_QUOTA'
      || (turn.pauseCandidate && turn.checkpointObserved)
      || classification.kind === 'resume-automation';
    const resume = shouldPlan
      ? resumePlanForState(state, event, previousPlan, pause, continuation)
      : { plan: previousPlan, requestCreated: false };
    state.resumePlan = resume.plan;
    continuation.resumePlan = resume.plan;
    turn.usageChecked = true;
    turn.effectivePolicy = state.currentPolicy;
    turn.policyAction = state.policyAction;
    writeJsonAtomic(statePath(), state);
    saveContinuationRecord(event, continuation);
    saveTurnRecord(event, turn);
    return { succeeded: true, state, turn, continuation, error: null, resumeRequestCreated: resume.requestCreated };
  } catch (error) {
    console.error(`[usage-guard] quota query failed: ${error.message}`);
    state = registerUsageFailure(state);
    turn.usageChecked = false;
    turn.effectivePolicy = state.currentPolicy;
    turn.policyAction = state.policyAction;
    writeJsonAtomic(statePath(), state);
    saveContinuationRecord(event, continuation);
    saveTurnRecord(event, turn);
    return { succeeded: false, state, turn, continuation, error: error.message, resumeRequestCreated: false };
  }
}

function updatePauseCandidate(turn, state, classification, policy, continuation = null) {
  if (!turn || classification.kind === 'resume-automation') return false;
  if (['PAUSED_QUOTA', 'COMPLETED', 'CANCELLED', 'WAITING_USER', 'WEEKLY_STOPPED'].includes(String(getValue(continuation, 'taskStatus') ?? ''))) return false;
  const action = String(getValue(state, 'policyAction') ?? '') || ({ EMERGENCY: 'SHORT_SUSPEND', CRITICAL: 'SHORT_CRITICAL' }[policy] ?? '');
  if (!['SHORT_CRITICAL', 'SHORT_SUSPEND', 'WEEKLY_FINALIZE', 'WEEKLY_STOP'].includes(action)) return false;
  if (turn.pauseCandidate) return false;
  const windows = getValue(state, 'windows') ?? {};
  const roles = getValue(state, 'windowRoles') ?? {};
  const role = action.startsWith('WEEKLY') ? 'weekly' : 'short';
  const candidateWindow = String(getValue(roles, role) ?? '');
  const candidate = candidateWindow ? getValue(windows, candidateWindow) : null;
  turn.pauseCandidate = true;
  turn.pauseReason = 'usage_guard';
  turn.pausePolicy = policy;
  turn.pauseCandidateAt = isoNow();
  turn.pauseWindow = candidateWindow || null;
  turn.pauseResetAt = toNumber(getValue(candidate, 'resetsAt'));
  turn.checkpointObserved = false;
  return true;
}

function checkpointHint(event, state, continuation) {
  const action = String(getValue(state, 'policyAction') ?? '');
  if (!['SHORT_CRITICAL', 'SHORT_SUSPEND', 'WEEKLY_FINALIZE', 'WEEKLY_STOP'].includes(action)) return '';
  if (String(getValue(continuation, 'taskStatus') ?? '') === 'PAUSED_QUOTA') return '';
  const reason = action.startsWith('WEEKLY') ? 'weekly_budget' : 'short_window';
  const mode = action.startsWith('WEEKLY') || String(getValue(state, 'weeklyPolicy') ?? '') === 'FINALIZE' ? 'finalize_only' : 'continue';
  const sessionId = String(getValue(event, 'session_id') ?? '');
  return ` If this turn must pause, write ${CHECKPOINT_RELATIVE_PATH.replaceAll(path.sep, '/')} with JSON containing sessionId ${JSON.stringify(sessionId)}, taskStatus "PAUSED_QUOTA", pauseReason "${reason}", checkpointPath "docs/plan/progress.md", revision "<new non-empty revision>", resumeMode "${mode}", and nextStep "<one bounded next step>"; let the post-tool hook register it before stopping.`;
}

function matchingResumeAutomation(event, state, planOverride = null) {
  const plan = planOverride ?? getValue(state, 'resumePlan');
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
  const action = String(getValue(state, 'policyAction') || 'UNKNOWN');
  const continuation = refresh.continuation ?? getContinuationRecord(event);
  if (override) return contextOutput('PreToolUse', `Usage Guard one-turn override is active. Continue deliberately; usage warnings still apply. ${policySummary(state)}`);
  if (updatePauseCandidate(turn, state, classification, policy, continuation)) saveTurnRecord(event, turn);
  if (classification.kind === 'resume-automation') {
    const plan = continuationPlan(continuation);
    const planned = activePlan(plan);
    if (action === 'WEEKLY_STOP') return denyOutput('Usage Guard weekly quota stop disables recovery heartbeats.');
    if (action !== 'SHORT_SUSPEND' && !planned) return {};
    if (!matchingResumeAutomation(event, state, plan)) return denyOutput('Usage Guard permits only the heartbeat matching the current recovery schedule key.');
    turn.resumeScheduleAttempted = true;
    turn.resumeScheduleKey = getValue(plan, 'scheduleKey');
    saveTurnRecord(event, turn);
    return contextOutput('PreToolUse', 'Usage Guard permits this matching bounded auto-resume heartbeat operation.');
  }
  if (policy === 'UNKNOWN' || action === 'UNKNOWN' || action === 'UNKNOWN_WINDOW_ROLE') return contextOutput('PreToolUse', 'Usage state is UNKNOWN; fail-open is active. Continue cautiously and preserve a checkpoint after repeated failures.', 'Usage Guard could not read quota and is failing open.');
  if (action === 'RUN' || policy === 'NORMAL') return {};
  if (action === 'SHORT_CONSERVE' || policy === 'CONSERVE') {
    if (classification.kind === 'expansion') return denyOutput('Usage Guard CONSERVE blocks new subagents and generated-media expansion.');
    return contextOutput('PreToolUse', `Usage Guard CONSERVE: ${policySummary(state)}. Keep scope narrow.`);
  }
  if (action === 'WEEKLY_LOW') {
    if (classification.kind === 'expansion') return denyOutput('Usage Guard WEEKLY_LOW blocks new scope and expansion.');
    return contextOutput('PreToolUse', `Usage Guard WEEKLY_LOW: finish the current coherent unit and prepare a complete handoff. ${policySummary(state)}`);
  }
  if (action === 'WEEKLY_STOP') {
    if (!classification.checkpointSafe) return denyOutput(`Usage Guard WEEKLY_STOP allows only a final bounded checkpoint: ${policySummary(state)}.`);
    return contextOutput('PreToolUse', `Usage Guard WEEKLY_STOP: write the complete handoff and stop; ${policySummary(state)}.${checkpointHint(event, state, continuation)}`);
  }
  if (action === 'WEEKLY_FINALIZE') {
    if (classification.cost === 'HIGH' || classification.kind === 'expansion') return denyOutput(`Usage Guard WEEKLY_FINALIZE blocks expansion: ${policySummary(state)}.`);
    return contextOutput('PreToolUse', `Usage Guard WEEKLY_FINALIZE: finish only the current coherent unit and write a complete handoff; ${policySummary(state)}.${checkpointHint(event, state, continuation)}`);
  }
  if (action === 'SHORT_CRITICAL' || (action === 'UNKNOWN' && policy === 'CRITICAL')) {
    if (classification.cost === 'HIGH') return denyOutput(`Usage Guard CRITICAL blocks high-cost work: ${policySummary(state)}.`);
    return contextOutput('PreToolUse', `Usage Guard CRITICAL: finish only the smallest necessary step; ${policySummary(state)}.${checkpointHint(event, state, continuation)}`);
  }
  if (action === 'SHORT_SUSPEND' || (action === 'UNKNOWN' && policy === 'EMERGENCY')) {
    if (!classification.checkpointSafe) return denyOutput(`Usage Guard EMERGENCY allows only bounded checkpoint, status, and reporting operations: ${policySummary(state)}.`);
    return contextOutput('PreToolUse', `Usage Guard EMERGENCY: this bounded checkpoint operation is allowed; do not expand its scope.${checkpointHint(event, state, continuation)}`);
  }
  return {};
}

function usagePostTool(event) {
  let state = getState();
  const turn = getTurnRecord(event) ?? newTurnRecord(event);
  const continuation = getContinuationRecord(event);
  turn.usageAttempted = true;
  try {
    const previousPlan = continuationPlan(continuation);
    state = usageToState(getValue(event, 'tool_response'), state);
    const resume = continuation.taskStatus === 'PAUSED_QUOTA'
      ? resumePlanForState(state, event, previousPlan, continuation, continuation)
      : { plan: previousPlan, requestCreated: false };
    state.resumePlan = resume.plan;
    continuation.resumePlan = resume.plan;
    turn.usageChecked = true;
    turn.effectivePolicy = state.currentPolicy;
    turn.policyAction = state.policyAction;
    writeJsonAtomic(statePath(), state);
    saveContinuationRecord(event, continuation);
    saveTurnRecord(event, turn);
    return contextOutput('PostToolUse', `Usage Guard updated: ${policySummary(state)}. This is a tool policy, not a work-capacity estimate.${resumePlanContext(state, resume.requestCreated, continuation.resumePlan)}`);
  } catch (error) {
    console.error(`[usage-guard] quota processing failed: ${error.message}`);
    state = registerUsageFailure(state);
    turn.usageChecked = false;
    turn.effectivePolicy = state.currentPolicy;
    turn.policyAction = state.policyAction;
    writeJsonAtomic(statePath(), state);
    saveContinuationRecord(event, continuation);
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
  const continuation = getContinuationRecord(event);
  const turn = getTurnRecord(event) ?? newTurnRecord(event);
  turn.resumeScheduleAttempted = true;
  const plan = continuationPlan(continuation);
  try {
    const response = getValue(event, 'tool_response');
    if (getValue(response, 'isError') === true) throw new Error('Automation tool reported an error.');
    const result = findAutomationResult(response);
    if (!result) throw new Error('Automation tool returned no creation or update result.');
    plan.status = 'SCHEDULED';
    plan.automationId = getValue(result, 'automationId') ?? getValue(result, 'id');
    plan.lastError = null;
    plan.updatedAt = isoNow();
    continuation.taskStatus = 'PAUSED_QUOTA';
    continuation.continuationEnabled = true;
    continuation.resumePlan = plan;
    continuation.lastError = null;
    state.resumePlan = plan;
    writeJsonAtomic(statePath(), state);
    saveContinuationRecord(event, continuation);
    saveTurnRecord(event, turn);
    return contextOutput('PostToolUse', `Usage Guard auto-resume scheduled for scheduleKey=${String(getValue(plan, 'scheduleKey') ?? '')}. Do not create another heartbeat.`);
  } catch (error) {
    plan.status = 'FAILED';
    plan.lastError = boundedErrorText(error.message);
    plan.updatedAt = isoNow();
    continuation.taskStatus = 'PAUSED_QUOTA';
    continuation.continuationEnabled = true;
    continuation.resumePlan = plan;
    continuation.lastError = plan.lastError;
    state.resumePlan = plan;
    writeJsonAtomic(statePath(), state);
    saveContinuationRecord(event, continuation);
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
    const continuation = beginUserPrompt(event);
    const turn = newTurnRecord(event);
    const refresh = await updateUsageSnapshot(event, turn);
    const override = turn.overrideOnce ? ' One-turn override is bound to this session and turn.' : '';
    if (refresh.succeeded) return contextOutput('UserPromptSubmit', `Usage Guard checked automatically: ${policySummary(refresh.state)}. Treat this as tool policy, not a work-capacity estimate.${resumePlanContext(refresh.state, refresh.resumeRequestCreated, refresh.continuation?.resumePlan ?? continuation.resumePlan)}${override}`);
    const checkpoint = Number(getValue(refresh.state, 'consecutiveFailures')) >= 3 ? ' Create a bounded recovery checkpoint before substantial work.' : '';
    return contextOutput('UserPromptSubmit', `Usage Guard query failed; fail-open is active. ${policySummary(refresh.state)}.${checkpoint}${override}`, 'Usage Guard could not read quota; work remains available.');
  }
  if (eventName === 'PreToolUse') return preToolPolicy(event);
  if (eventName === 'PostToolUse') {
    const toolName = String(getValue(event, 'tool_name'));
    if (toolName === AUTOMATION_TOOL_NAME) return automationPostTool(event);
    if (toolName === USAGE_TOOL_NAME) return usagePostTool(event);
    return checkpointPostTool(event);
  }
  if (eventName === 'SubagentStart') return contextOutput('SubagentStart', `Usage Guard applies inside this subagent. ${policySummary(getState())}. Converge when the assigned task is complete.`);
  if (eventName === 'PreCompact') return { systemMessage: `Usage Guard state preserved: ${policySummary(getState())}.` };
  if (eventName === 'PostCompact') return { systemMessage: `Usage Guard state restored: ${policySummary(getState())}.` };
  if (eventName === 'Stop') {
    if (Boolean(getValue(event, 'stop_hook_active'))) return {};
    let state = getState();
    const continuation = getContinuationRecord(event);
    let plan = continuationPlan(continuation);
    const turn = getTurnRecord(event);
    if (terminalTaskStatus(getValue(continuation, 'taskStatus'))) return {};
    const confirmed = String(getValue(continuation, 'taskStatus') ?? '') === 'PAUSED_QUOTA'
      && Boolean(getValue(continuation, 'checkpointRevision'))
      && Boolean(getValue(continuation, 'checkpointPath'));
    if (turn && Boolean(getValue(turn, 'pauseCandidate')) && !confirmed && !Boolean(getValue(turn, 'checkpointObserved')) && !Boolean(getValue(turn, 'checkpointRequestIssued'))) {
      turn.checkpointRequestIssued = true;
      saveTurnRecord(event, turn);
      return { decision: 'block', reason: `Usage Guard pause requires one verified checkpoint marker at ${CHECKPOINT_RELATIVE_PATH.replaceAll(path.sep, '/')}; write it with the required sessionId/taskStatus/pauseReason/checkpointPath/revision/nextStep fields, then let PostToolUse register it.` };
    }
    if (confirmed && String(getValue(state, 'policyAction') ?? '') === 'WEEKLY_STOP') {
      plan = newResumePlan({ status: 'WEEKLY_STOPPED', resumeMode: 'finalize_only' });
      continuation.taskStatus = 'WEEKLY_STOPPED';
      continuation.continuationEnabled = false;
      continuation.resumePlan = plan;
      state.resumePlan = plan;
      writeJsonAtomic(statePath(), state);
      saveContinuationRecord(event, continuation);
      return {};
    }
    if (!confirmed && String(getValue(state, 'policyAction') ?? '') === 'WEEKLY_STOP') return {};
    let requested = activePlan(plan) && String(getValue(plan, 'status')) === 'REQUESTED';
    if (confirmed && !activePlan(plan)) {
      const resume = resumePlanForState(state, event, plan, continuation, continuation);
      state.resumePlan = resume.plan;
      plan = resume.plan;
      continuation.resumePlan = plan;
      continuation.cycleId = toNumber(getValue(plan, 'cycleId')) ?? toNumber(getValue(continuation, 'cycleId')) ?? 0;
      requested = activePlan(plan) && String(getValue(plan, 'status')) === 'REQUESTED';
      writeJsonAtomic(statePath(), state);
      saveContinuationRecord(event, continuation);
    }
    const wakeAt = toNumber(getValue(plan, 'wakeAt'));
    const nowUnix = Math.floor(utcNow().getTime() / 1000);
    if (requested && (wakeAt === null || wakeAt <= nowUnix)) {
      plan.eligible = false;
      plan.status = 'SKIPPED_INVALID_RESET';
      plan.lastError = 'Recovery wake time expired before scheduling.';
      plan.updatedAt = isoNow();
      state.resumePlan = plan;
      continuation.resumePlan = plan;
      writeJsonAtomic(statePath(), state);
      saveContinuationRecord(event, continuation);
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
  utcNow, safeId, dataRoot, statePath, turnPath, continuationPath, readJsonFile, writeJsonAtomic,
  newResumePlan, newContinuationRecord, newDefaultState, getState, getContinuationRecord, saveContinuationRecord,
  toNumber, toWindow, findUsagePayload, windowRole, weeklyPolicyForRemaining, policySeverity, combinedPolicy, policyAction,
  policyForRemaining, reasonCode, usageToState, resumePlanForState, resumeAutomationRrule, resumeAutomationInput, resumePlanContext,
  rateLimitQuery, snapshotAgeSeconds, registerUsageFailure, policySummary, contextOutput,
  denyOutput, toolCommandText, toolClassification, overridePrompt, newTurnRecord,
  getTurnRecord, saveTurnRecord, updateUsageSnapshot, updatePauseCandidate, checkpointMarkerPath, readCheckpointMarker,
  checkpointPostTool, matchingResumeAutomation, removeExpiredTurns, preToolPolicy, usagePostTool, findAutomationResult,
  boundedErrorText, automationPostTool, recoveryScheduleKey, beginUserPrompt, invokeHookEvent, main,
};

if (require.main === module) main();
