'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
    stop_hook_active: false, prompt: 'Fix the issue', cwd: process.cwd(),
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
  const setMockUsage = (primaryUsed, secondaryUsed, primaryReset = 2000000000, secondaryReset = 2000001000) => g.writeJsonAtomic(mockResponsePath, {
    rateLimits: {
      primary: { usedPercent: primaryUsed, windowDurationMins: 300, resetsAt: primaryReset },
      secondary: { usedPercent: secondaryUsed, windowDurationMins: 10080, resetsAt: secondaryReset },
    },
  });
  setMockUsage(10, 20);
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
    assert.equal(state.shortPolicy, 'CRITICAL');
    assert.equal(state.weeklyPolicy, 'HEALTHY');
    assert.equal(state.policyAction, 'SHORT_CRITICAL');
    const normal = g.usageToState(usageResponse(10, 20), state);
    assert.equal(normal.currentPolicy, 'NORMAL');
    assert.equal(normal.previousPolicy, 'CRITICAL');
    assert.ok(normal.changedAt);
    const unknownRoleResponse = usageResponse(95, 20);
    unknownRoleResponse.content[0].text = JSON.stringify({ rateLimits: {
      primary: { usedPercent: 95, windowDurationMins: 60, resetsAt: 2000000000 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2000001000 },
    } });
    const unknownRole = g.usageToState(unknownRoleResponse, g.newDefaultState());
    assert.equal(unknownRole.policyAction, 'UNKNOWN_WINDOW_ROLE');
    assert.equal(g.resumePlanForState(unknownRole, event('UserPromptSubmit'), null).plan.status, 'SKIPPED_INVALID_WINDOW_ROLE');

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
    const wrappedStatusClass = g.toolClassification(event('PreToolUse', 'exec', 'text(await tools.exec_command({cmd:\"git status --short\"}))'));
    assert.deepEqual([wrappedStatusClass.cost, wrappedStatusClass.checkpointSafe], ['LOW', true]);
    const planClass = g.toolClassification(event('PreToolUse', 'apply_patch', '*** Update File: docs/plan/progress.md'));
    assert.deepEqual([planClass.cost, planClass.checkpointSafe], ['MEDIUM', true]);
    const wrappedPlanClass = g.toolClassification(event('PreToolUse', 'exec', 'text(await tools.apply_patch("*** Update File: docs/plan/progress.md"))'));
    assert.deepEqual([wrappedPlanClass.cost, wrappedPlanClass.checkpointSafe], ['MEDIUM', true]);

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
    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:07:00Z';
    const before = g.getState().lastSuccessfulAt;
    await g.preToolPolicy(event('PreToolUse', 'Bash', 'git status --short'));
    assert.notEqual(g.getState().lastSuccessfulAt, before);

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
    setMockUsage(95, 93);
    record.effectivePolicy = 'EMERGENCY';
    g.saveTurnRecord(turnEvent, record);
    assert.equal((await g.preToolPolicy(event('PreToolUse', 'Bash', 'git diff --stat'))).hookSpecificOutput.permissionDecision, undefined);
    assert.equal((await g.preToolPolicy(event('PreToolUse', 'Bash', 'rg --files'))).hookSpecificOutput.permissionDecision, 'deny');

    const pauseNow = Date.parse(process.env.USAGE_GUARD_NOW_UTC) / 1000;
    const pauseReset = pauseNow + 1800;
    setMockUsage(86, 20, pauseReset, pauseNow + 50000);
    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:07:16Z';
    const checkpointRoot = path.join(testRoot, 'checkpoint-workspace');
    fs.mkdirSync(path.join(checkpointRoot, 'docs', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(checkpointRoot, 'docs', 'plan', 'progress.md'), 'bounded checkpoint\n', 'utf8');
    const pauseEvent = event('PreToolUse', 'exec', 'text(await tools.apply_patch("*** Update File: docs/plan/progress.md"))');
    pauseEvent.turn_id = 'pause-turn';
    pauseEvent.cwd = checkpointRoot;
    const pauseContext = await g.preToolPolicy(pauseEvent);
    assert.match(pauseContext.hookSpecificOutput.additionalContext, /CRITICAL/);
    const pauseRecord = g.getTurnRecord(pauseEvent);
    assert.equal(pauseRecord.pauseCandidate, true);
    assert.equal(pauseRecord.pauseReason, 'usage_guard');
    assert.equal(pauseRecord.checkpointObserved, false);
    const marker = {
      sessionId: pauseEvent.session_id,
      taskStatus: 'PAUSED_QUOTA',
      pauseReason: 'short_window',
      checkpointPath: 'docs/plan/progress.md',
      revision: 'pause-r1',
      resumeMode: 'continue',
      nextStep: 'resume the current coherent unit',
    };
    g.writeJsonAtomic(g.checkpointMarkerPath(pauseEvent), marker);
    const checkpointPost = { ...pauseEvent, hook_event_name: 'PostToolUse', tool_response: { isError: false } };
    assert.match((await g.invokeHookEvent(checkpointPost)).hookSpecificOutput.additionalContext, /checkpoint registered/);
    assert.equal(g.getContinuationRecord(pauseEvent).taskStatus, 'PAUSED_QUOTA');
    assert.equal(g.getTurnRecord(pauseEvent).checkpointObserved, true);
    g.writeJsonAtomic(g.statePath(), g.usageToState(usageResponse(10, 20, pauseReset, pauseNow + 50000), g.getState()));
    const pauseStop = event('Stop');
    pauseStop.turn_id = 'pause-turn';
    const pauseDecision = await g.invokeHookEvent(pauseStop);
    assert.equal(pauseDecision.decision, 'block');
    assert.match(pauseDecision.reason, /"mode":"create"/);
    assert.equal(g.getState().resumePlan.status, 'REQUESTED');

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
    assert.equal(bothPlan.status, 'REQUESTED');
    assert.deepEqual(bothPlan.blockingWindows, ['primary']);
    assert.equal(bothPlan.resumeMode, 'finalize_only');
    assert.equal(g.resumePlanForState(g.usageToState(usageResponse(95, 20, null, nowUnix + 50000), g.newDefaultState()), resumeEvent, null).plan.status, 'SKIPPED_INVALID_RESET');
    assert.equal(g.resumePlanForState(g.usageToState(usageResponse(95, 20, nowUnix - 1, nowUnix + 50000), g.newDefaultState()), resumeEvent, null).plan.status, 'SKIPPED_INVALID_RESET');
    exactState.stale = true;
    assert.equal(g.resumePlanForState(exactState, resumeEvent, null).plan.status, 'NONE');
    exactState.stale = false;
    const duplicate = g.resumePlanForState(exactState, resumeEvent, exactPlanResult.plan);
    assert.equal(duplicate.requestCreated, false);
    assert.equal(duplicate.plan.scheduleKey, exactPlanResult.plan.scheduleKey);

    const resumeInput = g.resumeAutomationInput(exactPlanResult.plan);
    assert.deepEqual(
      { mode: resumeInput.mode, kind: resumeInput.kind, destination: resumeInput.destination, name: resumeInput.name, status: resumeInput.status },
      { mode: 'create', kind: 'heartbeat', destination: 'thread', name: 'Usage Guard resume', status: 'ACTIVE' },
    );
    assert.match(resumeInput.rrule, /^RRULE:FREQ=DAILY;BYHOUR=\d{2};BYMINUTE=\d{2};BYSECOND=\d{2};COUNT=1$/);
    assert.match(resumeInput.prompt, new RegExp(exactPlanResult.plan.scheduleKey));
    const utcWake = Date.parse('2026-09-03T12:34:56Z') / 1000;
    for (const [timezone, time] of [['Asia/Singapore', '20;BYMINUTE=34'], ['America/New_York', '08;BYMINUTE=34'], ['Asia/Kathmandu', '18;BYMINUTE=19']]) {
      const result = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(handlerPath)}).resumeAutomationRrule(${utcWake}));`], {
        env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 3000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `RRULE:FREQ=DAILY;BYHOUR=${time};BYSECOND=56;COUNT=1`, timezone);
    }
    assert.equal(g.resumeAutomationRrule(null), null);

    exactState.resumePlan = exactPlanResult.plan;
    resumeEvent.session_id = 'resume-session';
    resumeEvent.cwd = checkpointRoot;
    const resumeContinuation = g.newContinuationRecord(resumeEvent);
    resumeContinuation.taskStatus = 'PAUSED_QUOTA';
    resumeContinuation.pauseReason = 'short_window';
    resumeContinuation.pauseWindow = 'primary';
    resumeContinuation.pauseResetAt = exactReset;
    resumeContinuation.checkpointPath = 'docs/plan/progress.md';
    resumeContinuation.checkpointRevision = 'resume-checkpoint';
    resumeContinuation.resumePlan = exactPlanResult.plan;
    g.saveContinuationRecord(resumeEvent, resumeContinuation);
    g.writeJsonAtomic(g.statePath(), exactState);
    setMockUsage(95, 20, exactReset, nowUnix + 50000);
    const autoTurn = { ...g.newTurnRecord(resumeEvent), usageAttempted: true, usageChecked: true };
    g.saveTurnRecord(resumeEvent, autoTurn);
    const autoEvent = event('PreToolUse', g.constants.AUTOMATION_TOOL_NAME);
    autoEvent.session_id = resumeEvent.session_id;
    autoEvent.cwd = checkpointRoot;
    autoEvent.tool_input = resumeInput;
    assert.equal((await g.preToolPolicy(autoEvent)).hookSpecificOutput.permissionDecision, undefined);
    assert.equal(g.getTurnRecord(autoEvent).resumeScheduleAttempted, true);
    const suggested = event('PreToolUse', g.constants.AUTOMATION_TOOL_NAME);
    suggested.session_id = resumeEvent.session_id;
    suggested.cwd = checkpointRoot;
    suggested.tool_input = { ...resumeInput, mode: 'suggested_create' };
    assert.equal((await g.preToolPolicy(suggested)).hookSpecificOutput.permissionDecision, 'deny');
    const unrelated = event('PreToolUse', g.constants.AUTOMATION_TOOL_NAME);
    unrelated.session_id = resumeEvent.session_id;
    unrelated.cwd = checkpointRoot;
    unrelated.tool_input = { name: 'Other task', prompt: 'Unrelated automation' };
    assert.equal((await g.preToolPolicy(unrelated)).hookSpecificOutput.permissionDecision, 'deny');

    const successPost = event('PostToolUse', g.constants.AUTOMATION_TOOL_NAME);
    successPost.session_id = resumeEvent.session_id;
    successPost.cwd = checkpointRoot;
    successPost.tool_input = resumeInput;
    successPost.tool_response = { isError: false, content: [{ type: 'text', text: '{"status":"created","id":"automation-123"}' }] };
    g.automationPostTool(successPost);
    assert.equal(g.getState().resumePlan.status, 'SCHEDULED');
    assert.equal(g.getState().resumePlan.automationId, 'automation-123');
    const recoveryPrompt = event('UserPromptSubmit');
    recoveryPrompt.session_id = resumeEvent.session_id;
    recoveryPrompt.turn_id = 'recovery-turn';
    recoveryPrompt.cwd = checkpointRoot;
    recoveryPrompt.prompt = `Usage Guard recovery scheduleKey=${exactPlanResult.plan.scheduleKey}`;
    setMockUsage(10, 20);
    await g.invokeHookEvent(recoveryPrompt);
    const consumed = g.getContinuationRecord(recoveryPrompt);
    assert.equal(consumed.taskStatus, 'RUNNING');
    assert.equal(consumed.resumePlan.status, 'CONSUMED');

    const heartbeatEvent = event('PostToolUse', g.constants.USAGE_TOOL_NAME);
    heartbeatEvent.session_id = 'heartbeat-session';
    heartbeatEvent.turn_id = 'heartbeat-turn';
    heartbeatEvent.cwd = checkpointRoot;
    const heartbeatPlan = { ...exactPlanResult.plan, eligible: true, status: 'SCHEDULED', wakeAt: nowUnix - 1 };
    const heartbeatContinuation = g.newContinuationRecord(heartbeatEvent);
    heartbeatContinuation.taskStatus = 'PAUSED_QUOTA';
    heartbeatContinuation.pauseReason = 'short_window';
    heartbeatContinuation.pauseWindow = 'primary';
    heartbeatContinuation.pauseResetAt = nowUnix - 181;
    heartbeatContinuation.resumePlan = heartbeatPlan;
    g.saveContinuationRecord(heartbeatEvent, heartbeatContinuation);
    const heartbeatState = g.usageToState(usageResponse(10, 20, nowUnix - 181, nowUnix + 50000), g.newDefaultState());
    heartbeatState.resumePlan = heartbeatPlan;
    g.writeJsonAtomic(g.statePath(), heartbeatState);
    heartbeatEvent.tool_response = usageResponse(10, 20, nowUnix - 181, nowUnix + 50000);
    const heartbeatContext = await g.invokeHookEvent(heartbeatEvent);
    assert.doesNotMatch(heartbeatContext.hookSpecificOutput.additionalContext, /manual resume|SKIPPED_INVALID_RESET/i);
    assert.equal(g.getContinuationRecord(heartbeatEvent).taskStatus, 'RUNNING');
    assert.equal(g.getState().resumePlan.status, 'CONSUMED');

    const cycleEvent = event('PreToolUse', 'exec', 'text(await tools.apply_patch("*** Update File: docs/plan/progress.md"))');
    cycleEvent.session_id = resumeEvent.session_id;
    cycleEvent.turn_id = 'cycle-two';
    cycleEvent.cwd = checkpointRoot;
    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:16Z';
    setMockUsage(95, 20, nowUnix + 1800, nowUnix + 50000);
    await g.preToolPolicy(cycleEvent);
    g.writeJsonAtomic(g.checkpointMarkerPath(cycleEvent), {
      sessionId: cycleEvent.session_id,
      taskStatus: 'PAUSED_QUOTA',
      pauseReason: 'short_window',
      checkpointPath: 'docs/plan/progress.md',
      revision: 'cycle-two',
      resumeMode: 'continue',
      nextStep: 'continue the current unit',
    });
    await g.invokeHookEvent({ ...cycleEvent, hook_event_name: 'PostToolUse', tool_response: { isError: false } });
    const cycleStop = { ...cycleEvent, hook_event_name: 'Stop' };
    const cycleDecision = await g.invokeHookEvent(cycleStop);
    assert.equal(cycleDecision.decision, 'block');
    assert.equal(g.getContinuationRecord(cycleStop).resumePlan.cycleId, 2);
    assert.notEqual(g.getContinuationRecord(cycleStop).resumePlan.scheduleKey, exactPlanResult.plan.scheduleKey);
    const weeklyEvent = event('PreToolUse', 'Bash', 'git status --short');
    weeklyEvent.session_id = 'weekly-session';
    weeklyEvent.turn_id = 'weekly-turn';
    weeklyEvent.cwd = checkpointRoot;
    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:32Z';
    setMockUsage(10, 96, nowUnix + 50000, nowUnix + 70000);
    const weeklyContext = await g.preToolPolicy(weeklyEvent);
    assert.match(weeklyContext.hookSpecificOutput.additionalContext, /WEEKLY_STOP/);
    g.writeJsonAtomic(g.checkpointMarkerPath(weeklyEvent), {
      sessionId: weeklyEvent.session_id,
      taskStatus: 'PAUSED_QUOTA',
      pauseReason: 'weekly_budget',
      checkpointPath: 'docs/plan/progress.md',
      revision: 'weekly-stop',
      resumeMode: 'finalize_only',
      nextStep: 'wait for weekly reset',
    });
    await g.invokeHookEvent({ ...weeklyEvent, hook_event_name: 'PostToolUse', tool_response: { isError: false } });
    const weeklyStop = { ...weeklyEvent, hook_event_name: 'Stop' };
    assert.equal((await g.invokeHookEvent(weeklyStop)).decision, undefined);
    assert.equal(g.getState().resumePlan.status, 'WEEKLY_STOPPED');
    exactState.resumePlan = exactPlanResult.plan;
    g.writeJsonAtomic(g.statePath(), exactState);
    const failedPost = event('PostToolUse', g.constants.AUTOMATION_TOOL_NAME);
    failedPost.session_id = resumeEvent.session_id;
    failedPost.cwd = checkpointRoot;
    const failedContinuation = g.newContinuationRecord(failedPost);
    failedContinuation.resumePlan = exactPlanResult.plan;
    g.saveContinuationRecord(failedPost, failedContinuation);
    failedPost.tool_input = resumeInput;
    failedPost.tool_response = { isError: true };
    g.automationPostTool(failedPost);
    assert.equal(g.getState().resumePlan.status, 'FAILED');
    exactState.resumePlan = exactPlanResult.plan;
    g.writeJsonAtomic(g.statePath(), exactState);
    const genericPost = event('PostToolUse', g.constants.AUTOMATION_TOOL_NAME);
    genericPost.session_id = resumeEvent.session_id;
    genericPost.turn_id = 'generic-post-turn';
    genericPost.cwd = checkpointRoot;
    genericPost.tool_input = { name: 'Other task', prompt: 'Unrelated automation' };
    genericPost.tool_response = { isError: false, content: [{ type: 'text', text: '{"id":"generic"}' }] };
    g.automationPostTool(genericPost);
    assert.equal(g.getState().resumePlan.status, 'REQUESTED');

    const expiredState = structuredClone(exactState);
    expiredState.resumePlan = structuredClone(exactPlanResult.plan);
    expiredState.resumePlan.wakeAt = nowUnix - 1;
    expiredState.resumePlan.status = 'REQUESTED';
    expiredState.resumePlan.eligible = true;
    g.writeJsonAtomic(g.statePath(), expiredState);
    setMockUsage(95, 20, nowUnix - 1, nowUnix + 50000);
    const expiredStopEvent = event('Stop');
    expiredStopEvent.session_id = 'expired-session';
    expiredStopEvent.turn_id = 'expired-stop-turn';
    g.saveTurnRecord(expiredStopEvent, { ...g.newTurnRecord(expiredStopEvent), usageAttempted: true, usageChecked: true });
    const expiredContinuation = g.newContinuationRecord(expiredStopEvent);
    expiredContinuation.resumePlan = expiredState.resumePlan;
    g.saveContinuationRecord(expiredStopEvent, expiredContinuation);
    assert.equal((await g.invokeHookEvent(expiredStopEvent)).decision, undefined);
    assert.equal(g.getState().resumePlan.status, 'SKIPPED_INVALID_RESET');
    assert.equal(g.getState().resumePlan.eligible, false);
    assert.equal((await g.invokeHookEvent(expiredStopEvent)).decision, undefined);
    const expiredAutomation = event('PreToolUse', g.constants.AUTOMATION_TOOL_NAME);
    expiredAutomation.session_id = 'expired-session';
    expiredAutomation.turn_id = 'expired-automation-turn';
    expiredAutomation.tool_input = { name: 'Usage Guard resume', prompt: `Usage Guard recovery scheduleKey=${exactPlanResult.plan.scheduleKey}` };
    g.saveTurnRecord(expiredAutomation, { ...g.newTurnRecord(expiredAutomation), usageAttempted: true, usageChecked: true });
    assert.equal((await g.preToolPolicy(expiredAutomation)).hookSpecificOutput.permissionDecision, 'deny');

    exactState.resumePlan = exactPlanResult.plan;
    g.writeJsonAtomic(g.statePath(), exactState);
    const stopEvent = event('Stop');
    g.saveTurnRecord(stopEvent, { ...g.newTurnRecord(stopEvent), usageAttempted: true, usageChecked: true });
    const stopDecision = await g.invokeHookEvent(stopEvent);
    assert.equal(stopDecision.decision, 'block');
    assert.match(stopDecision.reason, /"mode":"create"/);
    assert.match(stopDecision.reason, /"destination":"thread"/);
    assert.match(stopDecision.reason, /"rrule":"RRULE:FREQ=DAILY;/);
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
    assert.equal(hooks.hooks.PostToolUse[0].matcher, '*');
    for (const hook of handlers) {
      assert.match(hook.command, /^node "\$PLUGIN_ROOT\/scripts\/usage-guard\.js"$/);
      assert.match(hook.commandWindows, /^node "\$env:PLUGIN_ROOT\\scripts\\usage-guard\.js"$/);
      assert.doesNotMatch(`${hook.command} ${hook.commandWindows}`, /pwsh|usage-guard\.ps1/i);
    }
    const ordinaryPost = event('PostToolUse', 'Bash', 'git status --short');
    ordinaryPost.tool_response = { content: [{ type: 'text', text: JSON.stringify(usageResponse(99, 99)) }] };
    const ordinarySnapshot = g.getState().lastSuccessfulAt;
    await g.invokeHookEvent(ordinaryPost);
    assert.equal(g.getState().lastSuccessfulAt, ordinarySnapshot);

    const processRoot = path.join(testRoot, 'process-smoke');
    setMockUsage(10, 20);
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

    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:00Z';
    const baselineEvent = event('PreToolUse');
    baselineEvent.session_id = 'equivalence-session';
    baselineEvent.turn_id = 'equivalence-turn';
    const equivalenceState = g.usageToState(usageResponse(89, 58), g.newDefaultState());
    const equivalenceResumeState = g.usageToState(usageResponse(95, 20, nowUnix + 1000, nowUnix + 50000), g.newDefaultState());
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

    const cacheRoot = path.join(testRoot, 'snapshot-cache');
    process.env.PLUGIN_DATA = cacheRoot;
    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:00Z';
    setMockUsage(10, 20);
    const firstSnapshot = await g.updateUsageSnapshot(event('UserPromptSubmit'));
    const firstTimestamp = firstSnapshot.state.lastSuccessfulAt;
    assert.equal(firstSnapshot.state.evidence.primaryRemaining, 90);

    setMockUsage(95, 20);
    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:14Z';
    const cachedSnapshot = await g.updateUsageSnapshot(event('PreToolUse', 'Bash', 'git status --short'));
    assert.equal(cachedSnapshot.state.evidence.primaryRemaining, 90);
    assert.equal(cachedSnapshot.state.lastSuccessfulAt, firstTimestamp);

    process.env.USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:16Z';
    const refreshedSnapshot = await g.updateUsageSnapshot(event('PreToolUse', 'Bash', 'git status --short'));
    assert.equal(refreshedSnapshot.state.evidence.primaryRemaining, 5);
    assert.notEqual(refreshedSnapshot.state.lastSuccessfulAt, firstTimestamp);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('a stalled app-server completes the handshake and the hook exits before its 15s limit', async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-guard-timeout-'));
  const server = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    let ready = false, notified = false;
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') setTimeout(() => {
        ready = true;
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
      }, 50);
      else if (message.method === 'initialized') {
        if (!ready) process.exit(2);
        notified = true;
      } else if (message.method === 'account/rateLimits/read' && (!ready || !notified)) process.exit(3);
    });
    setInterval(() => {}, 1000);
  `;
  const code = `
    const cp = require('node:child_process'), spawn = cp.spawn;
    cp.spawn = (command, args, options) => command === 'codex'
      ? spawn(process.execPath, ['-e', ${JSON.stringify(server)}], options)
      : spawn(command, args, options);
    require(${JSON.stringify(handlerPath)}).main();
  `;
  const env = { ...process.env, PLUGIN_DATA: testRoot };
  delete env.USAGE_GUARD_TEST_RESPONSE_PATH;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], { env, stdio: 'pipe', windowsHide: true });
      let stdout = '', stderr = '';
      const deadline = setTimeout(() => { child.kill(); reject(new Error('The hook did not exit within 14 seconds.')); }, 14_000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', error => { clearTimeout(deadline); reject(error); });
      child.on('close', exitCode => { clearTimeout(deadline); resolve({ stdout, stderr, exitCode }); });
      child.stdin.end(JSON.stringify(event('UserPromptSubmit')));
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /Timed out waiting for app-server account\/rateLimits\/read response/);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /query failed; fail-open/);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
