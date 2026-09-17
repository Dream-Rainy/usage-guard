$ErrorActionPreference = 'Stop'

$pluginRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$handler = Join-Path $pluginRoot 'scripts\usage-guard.ps1'
$fixturePath = Join-Path $PSScriptRoot 'fixtures\events.json'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("usage-guard-tests-" + [Guid]::NewGuid().ToString('N'))
$env:PLUGIN_DATA = $testRoot
$env:USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:00Z'

. $handler -NoMain

$script:Passed = 0
$script:Failed = 0

function Assert-True {
    param([bool]$Condition, [string]$Name)
    if ($Condition) {
        $script:Passed++
        Write-Host "PASS $Name"
    }
    else {
        $script:Failed++
        Write-Host "FAIL $Name" -ForegroundColor Red
    }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Name)
    Assert-True ([string]$Expected -ceq [string]$Actual) "$Name (expected=$Expected actual=$Actual)"
}

function New-UsageResponse {
    param(
        [double]$PrimaryUsed,
        [double]$SecondaryUsed,
        $PrimaryReset = 2000000000,
        $SecondaryReset = 2000001000
    )
    $payload = [ordered]@{
        rateLimits = [ordered]@{
            primary = [ordered]@{ usedPercent = $PrimaryUsed; windowDurationMins = 300; resetsAt = $PrimaryReset }
            secondary = [ordered]@{ usedPercent = $SecondaryUsed; windowDurationMins = 10080; resetsAt = $SecondaryReset }
        }
    }
    return [pscustomobject]@{
        content = @([pscustomobject]@{ type = 'text'; text = ($payload | ConvertTo-Json -Depth 10 -Compress) })
    }
}

function New-Event {
    param([string]$EventName, [string]$ToolName = $null, [string]$Command = '')
    return [pscustomobject]@{
        session_id = 'session-test'
        turn_id = 'turn-test'
        hook_event_name = $EventName
        tool_name = $ToolName
        tool_input = [pscustomobject]@{ command = $Command }
        tool_response = $null
        stop_hook_active = $false
        prompt = 'Fix the issue'
        cwd = (Get-Location).Path
    }
}

$mockResponsePath = Join-Path $testRoot 'mock-rate-limits.json'
function Set-MockUsage {
    param(
        [double]$PrimaryUsed,
        [double]$SecondaryUsed,
        $PrimaryReset = 2000000000,
        $SecondaryReset = 2000001000
    )
    Write-JsonAtomic $mockResponsePath ([ordered]@{
        rateLimits = [ordered]@{
            primary = [ordered]@{ usedPercent = $PrimaryUsed; windowDurationMins = 300; resetsAt = $PrimaryReset }
            secondary = [ordered]@{ usedPercent = $SecondaryUsed; windowDurationMins = 10080; resetsAt = $SecondaryReset }
        }
    })
}
Set-MockUsage 10 20
$env:USAGE_GUARD_TEST_RESPONSE_PATH = $mockResponsePath

try {
    $thresholds = @(
        @{ Remaining = 30; Expected = 'NORMAL' },
        @{ Remaining = 29.99; Expected = 'CONSERVE' },
        @{ Remaining = 15; Expected = 'CONSERVE' },
        @{ Remaining = 14.99; Expected = 'CRITICAL' },
        @{ Remaining = 8; Expected = 'CRITICAL' },
        @{ Remaining = 7.99; Expected = 'EMERGENCY' }
    )
    foreach ($case in $thresholds) {
        Assert-Equal $case.Expected (Get-PolicyForRemaining $case.Remaining) "threshold $($case.Remaining)"
    }

    $state = Convert-UsageToState (New-UsageResponse 89 58) (New-DefaultState)
    Assert-Equal 'CRITICAL' $state.currentPolicy 'strictest window wins'
    Assert-Equal 11 $state.evidence.effectiveRemaining 'effective remaining evidence'
    Assert-Equal 'PRIMARY_WINDOW_BELOW_15' $state.reasonCode 'machine-readable reason code'
    Assert-Equal 'UNKNOWN' $state.previousPolicy 'initial transition previous policy'

    $normal = Convert-UsageToState (New-UsageResponse 10 20) $state
    Assert-Equal 'NORMAL' $normal.currentPolicy 'transition current policy'
    Assert-Equal 'CRITICAL' $normal.previousPolicy 'transition previous policy'
    Assert-True (-not [string]::IsNullOrWhiteSpace($normal.changedAt)) 'transition timestamp present'

    $env:USAGE_GUARD_NOW_UTC = '2026-09-03T00:03:00Z'
    $stale = Register-UsageFailure $normal
    Assert-Equal 'NORMAL' $stale.currentPolicy 'five-minute cache retains policy'
    Assert-True ([bool]$stale.stale) 'stale marker set'
    $env:USAGE_GUARD_NOW_UTC = '2026-09-03T00:06:00Z'
    $unknown = Register-UsageFailure $normal
    Assert-Equal 'UNKNOWN' $unknown.currentPolicy 'expired cache fails open as unknown'
    Assert-Equal 'QUERY_FAILED_NO_CACHE' $unknown.reasonCode 'unknown failure reason'

    Assert-True (Test-OverridePrompt 'usage-guard: override once continue') 'override exact prefix'
    Assert-True (Test-OverridePrompt '  USAGE-GUARD: OVERRIDE ONCE') 'override case-insensitive with leading whitespace'
    Assert-True (-not (Test-OverridePrompt 'README says usage-guard: override once')) 'override rejected outside prompt prefix'
    Assert-True ((ConvertTo-SafeId '..\bad/name') -notmatch '[\\/]') 'filename sanitization'

    $agentClass = Get-ToolClassification (New-Event 'PreToolUse' 'Agent' '')
    Assert-Equal 'HIGH' $agentClass.Cost 'subagent is high cost'
    $statusClass = Get-ToolClassification (New-Event 'PreToolUse' 'Bash' 'git status --short')
    Assert-True ($statusClass.Cost -eq 'LOW' -and $statusClass.CheckpointSafe) 'git status is bounded checkpoint safe'
    $scanClass = Get-ToolClassification (New-Event 'PreToolUse' 'Bash' 'rg --files')
    Assert-True ($scanClass.Cost -eq 'HIGH' -and -not $scanClass.CheckpointSafe) 'repository scan is not checkpoint safe'
    $wrappedStatusClass = Get-ToolClassification (New-Event 'PreToolUse' 'exec' 'text(await tools.exec_command({cmd:"git status --short"}))')
    Assert-True ($wrappedStatusClass.Cost -eq 'LOW' -and $wrappedStatusClass.CheckpointSafe) 'wrapped exec status is bounded checkpoint safe'
    $planEdit = Get-ToolClassification (New-Event 'PreToolUse' 'apply_patch' '*** Update File: docs/plan/progress.md')
    Assert-True ($planEdit.Cost -eq 'MEDIUM' -and $planEdit.CheckpointSafe) 'planning edit is checkpoint safe'
    $wrappedPlanEdit = Get-ToolClassification (New-Event 'PreToolUse' 'exec' 'text(await tools.apply_patch("*** Update File: docs/plan/progress.md"))')
    Assert-True ($wrappedPlanEdit.Cost -eq 'MEDIUM' -and $wrappedPlanEdit.CheckpointSafe) 'wrapped planning edit is checkpoint safe'

    $events = Get-Content -Raw -LiteralPath $fixturePath | ConvertFrom-Json -Depth 40
    foreach ($eventName in @('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'Stop', 'SessionEnd')) {
        $event = Get-Value $events $eventName
        $result = Invoke-HookEvent $event
        $json = $result | ConvertTo-Json -Depth 40 -Compress
        Assert-True (-not [string]::IsNullOrWhiteSpace($json)) "hook contract $eventName emits JSON"
        $null = $json | ConvertFrom-Json -Depth 40
    }

    $turnEvent = New-Event 'UserPromptSubmit'
    $turnEvent.prompt = 'usage-guard: override once do it'
    $null = Invoke-HookEvent $turnEvent
    $record = Get-TurnRecord $turnEvent
    Assert-True ($record.overrideOnce -and $record.sessionId -eq 'session-test' -and $record.turnId -eq 'turn-test') 'override bound to session and turn'

    $freshState = Convert-UsageToState (New-UsageResponse 10 20) (New-DefaultState)
    Write-JsonAtomic (Get-StatePath) $freshState
    $record.usageAttempted = $true
    $record.usageChecked = $true
    $record.overrideOnce = $false
    Save-TurnRecord $turnEvent $record
    $env:USAGE_GUARD_NOW_UTC = '2026-09-03T00:07:00Z'
    $before = (Get-State).lastSuccessfulAt
    $preResult = Invoke-PreToolPolicy (New-Event 'PreToolUse' 'Bash' 'git status --short')
    $after = (Get-State).lastSuccessfulAt
    Assert-True ($before -cne $after) 'ordinary PreToolUse refreshes the usage snapshot'

    $stopTurn = New-Event 'UserPromptSubmit'
    $stopTurn.turn_id = 'stop-turn'
    $null = Invoke-HookEvent $stopTurn
    $stop = New-Event 'Stop'
    $stop.turn_id = 'stop-turn'
    $firstStop = Invoke-HookEvent $stop
    Assert-True ($null -eq $firstStop.decision) 'Stop does not create a retry loop after automatic query'
    $stop.stop_hook_active = $true
    $secondStop = Invoke-HookEvent $stop
    Assert-True ($null -eq $secondStop.decision) 'second Stop is allowed'

    $emergency = Convert-UsageToState (New-UsageResponse 95 93) (New-DefaultState)
    Write-JsonAtomic (Get-StatePath) $emergency
    Set-MockUsage 95 93
    $record.effectivePolicy = 'EMERGENCY'
    Save-TurnRecord $turnEvent $record
    $allowedCheckpoint = Invoke-PreToolPolicy (New-Event 'PreToolUse' 'Bash' 'git diff --stat')
    Assert-True ($null -eq $allowedCheckpoint.hookSpecificOutput.permissionDecision) 'emergency allows bounded checkpoint'
    $blockedScan = Invoke-PreToolPolicy (New-Event 'PreToolUse' 'Bash' 'rg --files')
    Assert-Equal 'deny' $blockedScan.hookSpecificOutput.permissionDecision 'emergency blocks repository scan'

    $pauseNow = [DateTimeOffset]::Parse($env:USAGE_GUARD_NOW_UTC).ToUnixTimeSeconds()
    $pauseReset = $pauseNow + 1800
    Set-MockUsage 86 20 $pauseReset ($pauseNow + 50000)
    $checkpointRoot = Join-Path $testRoot 'checkpoint-workspace'
    New-Item -ItemType Directory -Force -Path (Join-Path $checkpointRoot 'docs\plan') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $checkpointRoot 'docs\plan\progress.md'), 'bounded checkpoint')
    $pauseEvent = New-Event 'PreToolUse' 'exec' 'text(await tools.apply_patch("*** Update File: docs/plan/progress.md"))'
    $pauseEvent.turn_id = 'pause-turn'
    $pauseEvent.cwd = $checkpointRoot
    $pauseContext = Invoke-PreToolPolicy $pauseEvent
    Assert-True ($pauseContext.hookSpecificOutput.additionalContext -match 'CRITICAL') 'critical checkpoint warning is emitted'
    $pauseRecord = Get-TurnRecord $pauseEvent
    Assert-True ([bool]$pauseRecord.pauseCandidate -and $pauseRecord.pauseReason -eq 'usage_guard' -and -not [bool]$pauseRecord.checkpointObserved) 'critical checkpoint records a pause candidate'
    $marker = [ordered]@{
        sessionId = $pauseEvent.session_id
        taskStatus = 'PAUSED_QUOTA'
        pauseReason = 'short_window'
        checkpointPath = 'docs/plan/progress.md'
        revision = 'pause-r1'
        resumeMode = 'continue'
        nextStep = 'resume the current coherent unit'
    }
    Write-JsonAtomic (Join-Path $checkpointRoot $script:CheckpointRelativePath) $marker
    $checkpointPost = $pauseEvent | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40
    $checkpointPost.hook_event_name = 'PostToolUse'
    $checkpointPost.tool_response = [pscustomobject]@{ isError = $false }
    $null = Invoke-HookEvent $checkpointPost
    Assert-True ([bool](Get-TurnRecord $pauseEvent).checkpointObserved) 'verified checkpoint is registered after PostToolUse'
    $recovered = Convert-UsageToState (New-UsageResponse 10 20 $pauseReset ($pauseNow + 50000)) (Get-State)
    Write-JsonAtomic (Get-StatePath) $recovered
    $pauseStop = New-Event 'Stop'
    $pauseStop.turn_id = 'pause-turn'
    $pauseDecision = Invoke-HookEvent $pauseStop
    Assert-Equal 'block' $pauseDecision.decision 'checkpoint pause requests one recovery heartbeat'
    Assert-True ($pauseDecision.reason -match '"mode":"create"') 'checkpoint pause uses direct automation create'
    Assert-Equal 'REQUESTED' (Get-State).resumePlan.status 'checkpoint pause persists requested plan'

    $env:USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:00Z'
    $nowUnix = [DateTimeOffset]::Parse($env:USAGE_GUARD_NOW_UTC).ToUnixTimeSeconds()
    $resumeEvent = New-Event 'UserPromptSubmit'
    $exactReset = $nowUnix + $script:ResumeMaxWaitSeconds - $script:ResumeSafetySeconds
    $exactState = Convert-UsageToState (New-UsageResponse 95 20 $exactReset ($nowUnix + 50000)) (New-DefaultState)
    $exactPlanResult = Get-ResumePlanForState $exactState $resumeEvent $null
    Assert-True ([bool]$exactPlanResult.Plan.eligible) 'exactly six hours is auto-resume eligible'
    Assert-Equal 'REQUESTED' $exactPlanResult.Plan.status 'eligible plan requests heartbeat'
    Assert-Equal ($exactReset + $script:ResumeSafetySeconds) $exactPlanResult.Plan.wakeAt 'three-minute safety margin applied'
    Assert-Equal $script:ResumeMaxWaitSeconds $exactPlanResult.Plan.waitSeconds 'six-hour wait preserved'

    $tooLongReset = $exactReset + 1
    $tooLongState = Convert-UsageToState (New-UsageResponse 95 20 $tooLongReset ($nowUnix + 50000)) (New-DefaultState)
    $tooLongPlan = (Get-ResumePlanForState $tooLongState $resumeEvent $null).Plan
    Assert-Equal 'SKIPPED_LONG_WAIT' $tooLongPlan.status 'six hours plus one second is skipped'
    Assert-True (-not [bool]$tooLongPlan.eligible) 'long wait is ineligible'

    $primaryReset = $nowUnix + 1000
    $secondaryReset = $nowUnix + 2000
    $bothState = Convert-UsageToState (New-UsageResponse 95 94 $primaryReset $secondaryReset) (New-DefaultState)
    $bothPlan = (Get-ResumePlanForState $bothState $resumeEvent $null).Plan
    Assert-Equal $primaryReset $bothPlan.blockingResetAt 'short window drives recovery reset'
    Assert-Equal 'primary' ($bothPlan.blockingWindows -join ' ') 'weekly window remains independent'
    Assert-Equal 'finalize_only' $bothPlan.resumeMode 'weekly finalization changes recovery mode'

    $missingState = Convert-UsageToState (New-UsageResponse 95 20 $null ($nowUnix + 50000)) (New-DefaultState)
    $missingPlan = (Get-ResumePlanForState $missingState $resumeEvent $null).Plan
    Assert-Equal 'SKIPPED_INVALID_RESET' $missingPlan.status 'missing blocking reset is skipped'
    $pastState = Convert-UsageToState (New-UsageResponse 95 20 ($nowUnix - 1) ($nowUnix + 50000)) (New-DefaultState)
    $pastPlan = (Get-ResumePlanForState $pastState $resumeEvent $null).Plan
    Assert-Equal 'SKIPPED_INVALID_RESET' $pastPlan.status 'past blocking reset is skipped'
    $exactState.stale = $true
    $stalePlan = (Get-ResumePlanForState $exactState $resumeEvent $null).Plan
    Assert-Equal 'NONE' $stalePlan.status 'stale usage never schedules auto-resume'
    $exactState.stale = $false

    $duplicate = Get-ResumePlanForState $exactState $resumeEvent $exactPlanResult.Plan
    Assert-True (-not [bool]$duplicate.RequestCreated) 'matching requested schedule key is deduplicated'
    Assert-Equal $exactPlanResult.Plan.scheduleKey $duplicate.Plan.scheduleKey 'deduplication preserves schedule key'

    $resumeInput = Get-ResumeAutomationInput $exactPlanResult.Plan
    Assert-Equal 'create' $resumeInput.mode 'resume automation uses direct create'
    Assert-Equal 'heartbeat' $resumeInput.kind 'resume automation uses heartbeat kind'
    Assert-Equal 'thread' $resumeInput.destination 'resume automation targets the same thread'
    Assert-Equal 'Usage Guard resume' $resumeInput.name 'resume automation has stable name'
    Assert-Equal 'ACTIVE' $resumeInput.status 'resume automation is active'
    Assert-True ($resumeInput.rrule -match '^RRULE:FREQ=DAILY;BYHOUR=\d{2};BYMINUTE=\d{2};BYSECOND=\d{2};COUNT=1$') 'resume automation has a future one-shot RRULE'
    Assert-True ($resumeInput.prompt.Contains([string]$exactPlanResult.Plan.scheduleKey, [StringComparison]::Ordinal)) 'resume prompt binds schedule key'
    $utcWake = [DateTimeOffset]::Parse('2026-09-03T12:34:56Z').ToUnixTimeSeconds()
    Assert-Equal 'RRULE:FREQ=DAILY;BYHOUR=12;BYMINUTE=34;BYSECOND=56;COUNT=1' (Get-ResumeAutomationRrule $utcWake) 'resume RRULE uses UTC'
    Assert-True ($null -eq (Get-ResumeAutomationRrule $null)) 'invalid wake time has no RRULE'

    $exactState.resumePlan = $exactPlanResult.Plan
    Write-JsonAtomic (Get-StatePath) $exactState
    Set-MockUsage 95 20 $exactReset ($nowUnix + 50000)
    $autoTurn = New-TurnRecord $resumeEvent
    $autoTurn.usageAttempted = $true
    $autoTurn.usageChecked = $true
    Save-TurnRecord $resumeEvent $autoTurn
    $autoEvent = New-Event 'PreToolUse' $script:AutomationToolName
    $autoEvent.tool_input = [pscustomobject]$resumeInput
    $autoPre = Invoke-PreToolPolicy $autoEvent
    Assert-True ($null -eq $autoPre.hookSpecificOutput.permissionDecision) 'matching recovery automation allowed in emergency'
    Assert-True ([bool](Get-TurnRecord $autoEvent).resumeScheduleAttempted) 'automation attempt recorded before tool call'
    $suggestedAuto = New-Event 'PreToolUse' $script:AutomationToolName
    $suggestedAuto.tool_input = [pscustomobject]$resumeInput
    $suggestedAuto.tool_input.mode = 'suggested_create'
    $suggestedPre = Invoke-PreToolPolicy $suggestedAuto
    Assert-Equal 'deny' $suggestedPre.hookSpecificOutput.permissionDecision 'suggested automation denied in emergency'
    $unrelatedAuto = New-Event 'PreToolUse' $script:AutomationToolName
    $unrelatedAuto.tool_input = [pscustomobject]@{ name = 'Other task'; prompt = 'Unrelated automation' }
    $unrelatedPre = Invoke-PreToolPolicy $unrelatedAuto
    Assert-Equal 'deny' $unrelatedPre.hookSpecificOutput.permissionDecision 'unrelated automation denied in emergency'

    $successPost = New-Event 'PostToolUse' $script:AutomationToolName
    $successPost.tool_response = [pscustomobject]@{
        isError = $false
        content = @([pscustomobject]@{ type = 'text'; text = '{"status":"created","id":"automation-123"}' })
    }
    $null = Invoke-AutomationPostTool $successPost
    $scheduledState = Get-State
    Assert-Equal 'SCHEDULED' $scheduledState.resumePlan.status 'successful automation recorded as scheduled'
    Assert-Equal 'automation-123' $scheduledState.resumePlan.automationId 'automation id persisted'

    $exactState.resumePlan = $exactPlanResult.Plan
    Write-JsonAtomic (Get-StatePath) $exactState
    $failedPost = New-Event 'PostToolUse' $script:AutomationToolName
    $failedPost.tool_response = [pscustomobject]@{ isError = $true; content = @() }
    $null = Invoke-AutomationPostTool $failedPost
    Assert-Equal 'FAILED' (Get-State).resumePlan.status 'failed automation recorded without retry loop'

    $exactState.resumePlan = $exactPlanResult.Plan
    Write-JsonAtomic (Get-StatePath) $exactState
    $genericIdPost = New-Event 'PostToolUse' $script:AutomationToolName
    $genericIdPost.tool_response = [pscustomobject]@{
        isError = $false
        content = @([pscustomobject]@{ type = 'text'; text = '{"id":"request-only"}' })
    }
    $null = Invoke-AutomationPostTool $genericIdPost
    Assert-Equal 'FAILED' (Get-State).resumePlan.status 'generic response id is not treated as scheduling success'

    $expiredState = $exactState | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40
    $expiredPlan = $exactPlanResult.Plan | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40
    $expiredPlan.wakeAt = $nowUnix - 1
    $expiredPlan.status = 'REQUESTED'
    $expiredPlan.eligible = $true
    $expiredState.resumePlan = $expiredPlan
    Write-JsonAtomic (Get-StatePath) $expiredState
    Set-MockUsage 95 20 ($nowUnix - 1) ($nowUnix + 50000)
    $expiredStopEvent = New-Event 'Stop'
    $expiredStopEvent.turn_id = 'expired-stop-turn'
    $expiredStopTurn = New-TurnRecord $expiredStopEvent
    $expiredStopTurn.usageAttempted = $true
    $expiredStopTurn.usageChecked = $true
    Save-TurnRecord $expiredStopEvent $expiredStopTurn
    $expiredStopFirst = Invoke-HookEvent $expiredStopEvent
    Assert-True ($null -eq $expiredStopFirst.decision) 'expired resume does not block Stop'
    Assert-Equal 'SKIPPED_INVALID_RESET' (Get-State).resumePlan.status 'expired resume is invalidated'
    Assert-True (-not [bool](Get-State).resumePlan.eligible) 'expired resume is no longer eligible'
    $expiredStopSecond = Invoke-HookEvent $expiredStopEvent
    Assert-True ($null -eq $expiredStopSecond.decision) 'expired resume is not retried'
    $expiredAutomation = New-Event 'PreToolUse' $script:AutomationToolName
    $expiredAutomation.turn_id = 'expired-automation-turn'
    $expiredAutomation.tool_input = [pscustomobject]@{
        name = 'Usage Guard resume'
        prompt = "Usage Guard recovery scheduleKey=$($exactPlanResult.Plan.scheduleKey)"
    }
    $expiredAutomationTurn = New-TurnRecord $expiredAutomation
    $expiredAutomationTurn.usageAttempted = $true
    $expiredAutomationTurn.usageChecked = $true
    Save-TurnRecord $expiredAutomation $expiredAutomationTurn
    $expiredAutomationPre = Invoke-PreToolPolicy $expiredAutomation
    Assert-Equal 'deny' $expiredAutomationPre.hookSpecificOutput.permissionDecision 'expired heartbeat is denied'

    $exactState.resumePlan = $exactPlanResult.Plan
    Write-JsonAtomic (Get-StatePath) $exactState
    $stopResumeEvent = New-Event 'Stop'
    $stopResumeTurn = New-TurnRecord $stopResumeEvent
    $stopResumeTurn.usageAttempted = $true
    $stopResumeTurn.usageChecked = $true
    Save-TurnRecord $stopResumeEvent $stopResumeTurn
    $resumeStopFirst = Invoke-HookEvent $stopResumeEvent
    Assert-Equal 'block' $resumeStopFirst.decision 'eligible unattempted resume gets one Stop continuation'
    Assert-True ($resumeStopFirst.reason -match '"mode":"create"') 'Stop continuation includes direct create mode'
    Assert-True ($resumeStopFirst.reason -match '"destination":"thread"') 'Stop continuation includes same-thread destination'
    Assert-True ($resumeStopFirst.reason -match '"rrule":"RRULE:FREQ=DAILY;') 'Stop continuation includes one-shot RRULE'
    $resumeStopSecond = Invoke-HookEvent $stopResumeEvent
    Assert-True ($null -eq $resumeStopSecond.decision) 'resume Stop continuation is not repeated'
    $stopResumeEvent.stop_hook_active = $true
    $resumeStopActive = Invoke-HookEvent $stopResumeEvent
    Assert-True ($null -eq $resumeStopActive.decision) 'active Stop hook backstop always allows stop'

    $handlerText = Get-Content -Raw -LiteralPath $handler
    Assert-True ($handlerText -notmatch 'rateLimitResetCredit/consume') 'handler never calls reset-credit consume API'

    $env:PLUGIN_DATA = Join-Path $testRoot 'concurrency'
    $handlerForParallel = $handler
    1..8 | ForEach-Object -Parallel {
        $env:PLUGIN_DATA = $using:env:PLUGIN_DATA
        . $using:handlerForParallel -NoMain
        Write-JsonAtomic (Get-StatePath) ([ordered]@{ schemaVersion = 1; writer = $_; currentPolicy = 'NORMAL' })
    } -ThrottleLimit 8
    $concurrentState = Read-JsonFile (Get-StatePath)
    Assert-True ($null -ne $concurrentState -and $concurrentState.schemaVersion -eq 1) 'concurrent atomic writes preserve valid JSON'
}
finally {
    Remove-Item Env:USAGE_GUARD_NOW_UTC -ErrorAction SilentlyContinue
    Remove-Item Env:USAGE_GUARD_TEST_RESPONSE_PATH -ErrorAction SilentlyContinue
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    if ($resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [System.IO.Directory]::Exists($resolvedTestRoot)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "RESULT passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) { exit 1 }
