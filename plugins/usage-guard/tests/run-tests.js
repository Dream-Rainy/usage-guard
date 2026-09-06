'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const handlerPath = path.resolve(__dirname, '..', 'scripts', 'usage-guard.js');
const g = require(handlerPath);

function usageResponse(primaryUsed, secondaryUsed, primaryReset = 2000000000, secondaryReset = 2000001000) {
  const payload = {
    rateLimits: {
      primary: { usedPercent: primaryUsed, windowDurationMins: 300, resetsAt: primaryReset },
      secondary: { usedPercent: secondaryUsed, windowDurationMins: 10080, resetsAt: secondaryReset },
    },
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function event(eventName, toolName = null, command = '') {
  return {
    session_id: 'session-test', turn_id: 'turn-test', hook_event_name: eventName,
    tool_name: toolName, tool_input: { command }, tool_response: null,
    stop_hook_active: false, prompt: 'Fix the issue',
  };
}

function runWorker(dataRoot, index) {
  return new Promise((resolve, reject) => {
    const code = `const g=require(${JSON.stringify(handlerPath)}); process.env.PLUGIN_DATA=${JSON.stringify(dataRoot)}; g.writeJsonAtomic(g.statePath(),{schemaVersion:2,index:${index}});`;
    const child = spawn(process.execPath, ['-e', code], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', codeValue => codeValue === 0 ? resolve() : reject(new Error(`worker ${index} failed: ${stderr}`)));
  });
}

function runHandler(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [handlerPath], { env: { ...process.env, ...env }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', codeValue => codeValue === 0 ? resolve({ stdout, stderr }) : reject(new Error(`handler failed: ${stderr}`)));
    child.stdin.end(input);
  });
}

function runPowerShellBaseline() {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'equivalence-baseline.ps1');
    const powerShellHandler = path.resolve(__dirname, '..', 'scripts', 'usage-guard.ps1');
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-HandlerPath', powerShellHandler], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', codeValue => codeValue === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`PowerShell baseline failed: ${stderr}`)));
  });
}

test('Usage Guard JavaScript handler preserves policy and hook behavior', async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-guard-js-tests-'));
  const previousEnv = { ...process.env };
  process.env.PLUGIN_DATA = testRoot;
  process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:00Z';
  const mockResponsePath = path.join(testRoot, 'mock-rate-limits.json');
  g.writeJsonAtomic(mockResponsePath, {
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000000000 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2000001000 },
    },
  });
  process.env.USAGE_GUARD_TEST_RESPONSE_PATH = mockResponsePath;

  try {
    for (const [remaining, expected] of [[30, 'NORMAL'], [29.99, 'CONSERVE'], [15, 'CONSERVE'], [14.99, 'CRITICAL'], [8, 'CRITICAL'], [7.99, 'EMERGENCY']]) {
      assert.equal(g.policyForRemaining(remaining), expected, `threshold ${remaining}`);
    }

    const state = g.usageToState(usageResponse(89, 58), g.newDefaultState());
    assert.equal(state.currentPolicy, 'CRITICAL');
    assert.equal(state.evidence.effectiveRemaining, 11);
    assert.equal(state.reasonCode, 'PRIMARY_WINDOW_BELOW_15');
    assert.equal(state.previousPolicy, 'UNKNOWN');
    const normal = g.usageToState(usageResponse(10, 20), state);
    assert.equal(normal.currentPolicy, 'NORMAL');
    assert.equal(normal.previousPolicy, 'CRITICAL');
    assert.ok(normal.changedAt);

    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:03:00Z';
    const stale = g.registerUsageFailure(structuredClone(normal));
    assert.equal(stale.currentPolicy, 'NORMAL');
    assert.equal(stale.stale, true);
    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:06:00Z';
    const unknown = g.registerUsageFailure(structuredClone(normal));
    assert.equal(unknown.currentPolicy, 'UNKNOWN');
    assert.equal(unknown.reasonCode, 'QUERY_FAILED_NO_CACHE');

    assert.equal(g.overridePrompt('usage-guard: override once continue'), true);
    assert.equal(g.overridePrompt('  USAGE-GUARD: OVERRIDE ONCE'), true);
    assert.equal(g.overridePrompt('README says usage-guard: override once'), false);
    assert.doesNotMatch(g.safeId('..\\bad/name'), /[\\/]/);

    assert.equal(g.toolClassification(event('PreToolUse', 'Agent')).cost, 'HIGH');
    const statusClass = g.toolClassification(event('PreToolUse', 'Bash', 'git status --short'));
    assert.deepEqual([statusClass.cost, statusClass.checkpointSafe], ['LOW', true]);
    const scanClass = g.toolClassification(event('PreToolUse', 'Bash', 'rg --files'));
    assert.deepEqual([scanClass.cost, scanClass.checkpointSafe], ['HIGH', false]);
    const planClass = g.toolClassification(event('PreToolUse', 'apply_patch', '*** Update File: docs/plan/progress.md'));
    assert.deepEqual([planClass.cost, planClass.checkpointSafe], ['MEDIUM', true]);

    const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'events.json'), 'utf8'));
    for (const eventName of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'Stop', 'SessionEnd']) {
      const result = await g.invokeHookEvent(fixtures[eventName]);
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)), `${eventName} emits JSON`);
    }

    const turnEvent = event('UserPromptSubmit');
    turnEvent.prompt = 'usage-guard: override once do it';
    await g.invokeHookEvent(turnEvent);
    let record = g.getTurnRecord(turnEvent);
    assert.equal(record.overrideOnce, true);
    assert.equal(record.sessionId, 'session-test');
    assert.equal(record.turnId, 'turn-test');

    const freshState = g.usageToState(usageResponse(10, 20), g.newDefaultState());
    g.writeJsonAtomic(g.statePath(), freshState);
    record = { ...record, usageAttempted: true, usageChecked: true, overrideOnce: false };
    g.saveTurnRecord(turnEvent, record);
    const before = g.getState().lastSuccessfulAt;
    await g.preToolPolicy(event('PreToolUse', 'Bash', 'git status --short'));
    assert.equal(g.getState().lastSuccessfulAt, before);

    const stopTurn = event('UserPromptSubmit');
    stopTurn.turn_id = 'stop-turn';
    await g.invokeHookEvent(stopTurn);
    const stop = event('Stop');
    stop.turn_id = 'stop-turn';
    assert.equal((await g.invokeHookEvent(stop)).decision, undefined);
    stop.stop_hook_active = true;
    assert.equal((await g.invokeHookEvent(stop)).decision, undefined);

    const emergency = g.usageToState(usageResponse(95, 93), g.newDefaultState());
    g.writeJsonAtomic(g.statePath(), emergency);
    record.effectivePolicy = 'EMERGENCY';
    g.saveTurnRecord(turnEvent, record);
    assert.equal((await g.preToolPolicy(event('PreToolUse', 'Bash', 'git diff --stat'))).hookSpecificOutput.permissionDecision, undefined);
    assert.equal((await g.preToolPolicy(event('PreToolUse', 'Bash', 'rg --files'))).hookSpecificOutput.permissionDecision, 'deny');

    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:00Z';
    const nowUnix = Date.parse(process.env.USAGE_GUARD_NOW_UTC) / 1000;
    const resumeEvent = event('UserPromptSubmit');
    const exactReset = nowUnix + g.constants.RESUME_MAX_WAIT_SECONDS - g.constants.RESUME_SAFETY_SECONDS;
    const exactState = g.usageToState(usageResponse(95, 20, exactReset, nowUnix + 50000), g.newDefaultState());
    const exactPlanResult = g.resumePlanForState(exactState, resumeEvent, null);
    assert.equal(exactPlanResult.plan.eligible, true);
    assert.equal(exactPlanResult.plan.status, 'REQUESTED');
    assert.equal(exactPlanResult.plan.wakeAt, exactReset + g.constants.RESUME_SAFETY_SECONDS);
    assert.equal(exactPlanResult.plan.waitSeconds, g.constants.RESUME_MAX_WAIT_SECONDS);

    const tooLong = g.resumePlanForState(g.usageToState(usageResponse(95, 20, exactReset + 1, nowUnix + 50000), g.newDefaultState()), resumeEvent, null).plan;
    assert.equal(tooLong.status, 'SKIPPED_LONG_WAIT');
    assert.equal(tooLong.eligible, false);
    const bothPlan = g.resumePlanForState(g.usageToState(usageResponse(95, 94, nowUnix + 1000, nowUnix + 2000), g.newDefaultState()), resumeEvent, null).plan;
    assert.equal(bothPlan.blockingResetAt, nowUnix + 2000);
    assert.deepEqual(bothPlan.blockingWindows, ['primary', 'secondary']);
    assert.equal(g.resumePlanForState(g.usageToState(usageResponse(95, 20, null, nowUnix + 50000), g.newDefaultState()), resumeEvent, null).plan.status, 'SKIPPED_INVALID_RESET');
    assert.equal(g.resumePlanForState(g.usageToState(usageResponse(95, 20, nowUnix - 1, nowUnix + 50000), g.newDefaultState()), resumeEvent, null).plan.status, 'SKIPPED_INVALID_RESET');
    exactState.stale = true;
    assert.equal(g.resumePlanForState(exactState, resumeEvent, null).plan.status, 'NONE');
    exactState.stale = false;
    const duplicate = g.resumePlanForState(exactState, resumeEvent, exactPlanResult.plan);
    assert.equal(duplicate.requestCreated, false);
    assert.equal(duplicate.plan.scheduleKey, exactPlanResult.plan.scheduleKey);

    exactState.resumePlan = exactPlanResult.plan;
    g.writeJsonAtomic(g.statePath(), exactState);
    const autoTurn = { ...g.newTurnRecord(resumeEvent), usageAttempted: true, usageChecked: true };
    g.saveTurnRecord(resumeEvent, autoTurn);
    const autoEvent = event('PreToolUse', g.constants.AUTOMATION_TOOL_NAME);
    autoEvent.tool_input = { name: 'Usage Guard resume', prompt: `Usage Guard recovery scheduleKey=${exactPlanResult.plan.scheduleKey}` };
    assert.equal((await g.preToolPolicy(autoEvent)).hookSpecificOutput.permissionDecision, undefined);
    assert.equal(g.getTurnRecord(autoEvent).resumeScheduleAttempted, true);
    const unrelated = event('PreToolUse', g.constants.AUTOMATION_TOOL_NAME);
    unrelated.tool_input = { name: 'Other task', prompt: 'Unrelated automation' };
    assert.equal((await g.preToolPolicy(unrelated)).hookSpecificOutput.permissionDecision, 'deny');

    const successPost = event('PostToolUse', g.constants.AUTOMATION_TOOL_NAME);
    successPost.tool_response = { isError: false, content: [{ type: 'text', text: '{"status":"created","id":"automation-123"}' }] };
    g.automationPostTool(successPost);
    assert.equal(g.getState().resumePlan.status, 'SCHEDULED');
    assert.equal(g.getState().resumePlan.automationId, 'automation-123');
    exactState.resumePlan = exactPlanResult.plan;
    g.writeJsonAtomic(g.statePath(), exactState);
    const failedPost = event('PostToolUse', g.constants.AUTOMATION_TOOL_NAME);
    failedPost.tool_response = { isError: true };
    g.automationPostTool(failedPost);
    assert.equal(g.getState().resumePlan.status, 'FAILED');
    exactState.resumePlan = exactPlanResult.plan;
    g.writeJsonAtomic(g.statePath(), exactState);
    const genericPost = event('PostToolUse', g.constants.AUTOMATION_TOOL_NAME);
    genericPost.tool_response = { isError: false, content: [{ type: 'text', text: '{"id":"generic"}' }] };
    g.automationPostTool(genericPost);
    assert.equal(g.getState().resumePlan.status, 'FAILED');

    exactState.resumePlan = exactPlanResult.plan;
    g.writeJsonAtomic(g.statePath(), exactState);
    const stopEvent = event('Stop');
    g.saveTurnRecord(stopEvent, { ...g.newTurnRecord(stopEvent), usageAttempted: true, usageChecked: true });
    assert.equal((await g.invokeHookEvent(stopEvent)).decision, 'block');
    assert.equal((await g.invokeHookEvent(stopEvent)).decision, undefined);
    stopEvent.stop_hook_active = true;
    assert.equal((await g.invokeHookEvent(stopEvent)).decision, undefined);

    assert.doesNotMatch(fs.readFileSync(handlerPath, 'utf8'), /consumeAccountRateLimitResetCredit|rateLimitResetCredit.*consume/);

    const lockTarget = path.join(testRoot, 'stale-lock-state.json');
    fs.writeFileSync(`${lockTarget}.lock`, '{}');
    const old = new Date(Date.now() - g.constants.LOCK_STALE_MS - 1000);
    fs.utimesSync(`${lockTarget}.lock`, old, old);
    g.writeJsonAtomic(lockTarget, { recovered: true });
    assert.equal(g.readJsonFile(lockTarget).recovered, true);

    const concurrentRoot = path.join(testRoot, 'concurrent');
    await Promise.all(Array.from({ length: 8 }, (_, index) => runWorker(concurrentRoot, index)));
    const concurrent = JSON.parse(fs.readFileSync(path.join(concurrentRoot, 'state.json'), 'utf8'));
    assert.equal(concurrent.schemaVersion, 2);
    assert.equal(Number.isInteger(concurrent.index), true);

    assert.equal(path.isAbsolute(g.dataRoot()), true);
    assert.equal(path.basename(g.statePath()), 'state.json');

    const hooks = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    const handlers = Object.values(hooks.hooks).flatMap(groups => groups).flatMap(group => group.hooks);
    assert.equal(handlers.length, 9);
    for (const hook of handlers) {
      assert.match(hook.command, /^node "\$PLUGIN_ROOT\/scripts\/usage-guard\.js"$/);
      assert.match(hook.commandWindows, /^node "\$env:PLUGIN_ROOT\\scripts\\usage-guard\.js"$/);
      assert.doesNotMatch(`${hook.command} ${hook.commandWindows}`, /pwsh|usage-guard\.ps1/i);
    }

    const processRoot = path.join(testRoot, 'process-smoke');
    const processResult = await runHandler(JSON.stringify(event('UserPromptSubmit')), {
      PLUGIN_DATA: processRoot,
      USAGE_GUARD_TEST_RESPONSE_PATH: mockResponsePath,
      USAGE_GUARD_NOW_UTC: '2026-09-03T00:00:00Z',
    });
    const processOutput = JSON.parse(processResult.stdout);
    assert.equal(processOutput.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(processOutput.hookSpecificOutput.additionalContext, /state=NORMAL/);
    assert.equal(processResult.stderr, '');
    const malformedResult = await runHandler('{bad json', { PLUGIN_DATA: processRoot });
    assert.match(JSON.parse(malformedResult.stdout).systemMessage, /failed safely/);

    const baselineEvent = event('PreToolUse');
    baselineEvent.session_id = 'equivalence-session';
    baselineEvent.turn_id = 'equivalence-turn';
    const equivalenceState = g.usageToState(usageResponse(89, 58), g.newDefaultState());
    const equivalenceResumeState = g.usageToState(usageResponse(95, 94, nowUnix + 1000, nowUnix + 2000), g.newDefaultState());
    const equivalenceResume = g.resumePlanForState(equivalenceResumeState, baselineEvent, null).plan;
    const jsSnapshot = {
      thresholds: [30, 29.99, 15, 14.99, 8, 7.99].map(g.policyForRemaining),
      state: {
        policy: equivalenceState.currentPolicy,
        reason: equivalenceState.reasonCode,
        effective: equivalenceState.evidence.effectiveRemaining,
        primary: equivalenceState.evidence.primaryRemaining,
        secondary: equivalenceState.evidence.secondaryRemaining,
      },
      override: [g.overridePrompt('usage-guard: override once continue'), g.overridePrompt('README says usage-guard: override once')],
      classifications: [
        g.toolClassification(event('PreToolUse', 'Agent')),
        g.toolClassification(event('PreToolUse', 'Bash', 'git status --short')),
        g.toolClassification(event('PreToolUse', 'Bash', 'rg --files')),
        g.toolClassification(event('PreToolUse', 'apply_patch', '*** Update File: docs/plan/progress.md')),
      ],
      resume: {
        eligible: equivalenceResume.eligible,
        blockingWindows: equivalenceResume.blockingWindows,
        blockingResetAt: equivalenceResume.blockingResetAt,
        waitSeconds: equivalenceResume.waitSeconds,
        status: equivalenceResume.status,
      },
      sixHour: g.resumePlanForState(g.usageToState(usageResponse(95, 20, exactReset, nowUnix + 50000), g.newDefaultState()), baselineEvent, null).plan.status,
    };
    if (process.platform === 'win32') {
      assert.deepEqual(jsSnapshot, await runPowerShellBaseline());
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
