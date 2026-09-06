param(
    [Parameter(Mandatory = $true)]
    [string]$HandlerPath
)

$ErrorActionPreference = 'Stop'
$env:USAGE_GUARD_NOW_UTC = '2026-09-03T00:00:00Z'
. $HandlerPath -NoMain

function New-UsageResponse {
    param([double]$PrimaryUsed, [double]$SecondaryUsed, $PrimaryReset = 2000000000, $SecondaryReset = 2000001000)
    $payload = [ordered]@{
        rateLimits = [ordered]@{
            primary = [ordered]@{ usedPercent = $PrimaryUsed; windowDurationMins = 300; resetsAt = $PrimaryReset }
            secondary = [ordered]@{ usedPercent = $SecondaryUsed; windowDurationMins = 10080; resetsAt = $SecondaryReset }
        }
    }
    return [pscustomobject]@{ content = @([pscustomobject]@{ type = 'text'; text = ($payload | ConvertTo-Json -Depth 10 -Compress) }) }
}

function New-Event {
    param([string]$ToolName, [string]$Command = '')
    return [pscustomobject]@{
        session_id = 'equivalence-session'
        turn_id = 'equivalence-turn'
        tool_name = $ToolName
        tool_input = [pscustomobject]@{ command = $Command }
        prompt = 'Fix the issue'
    }
}

$nowUnix = [DateTimeOffset]::Parse($env:USAGE_GUARD_NOW_UTC).ToUnixTimeSeconds()
$exactReset = $nowUnix + $script:ResumeMaxWaitSeconds - $script:ResumeSafetySeconds
$state = Convert-UsageToState (New-UsageResponse 89 58) (New-DefaultState)
$resumeState = Convert-UsageToState (New-UsageResponse 95 94 ($nowUnix + 1000) ($nowUnix + 2000)) (New-DefaultState)
$resume = Get-ResumePlanForState $resumeState (New-Event '') $null

$snapshot = [ordered]@{
    thresholds = @(30, 29.99, 15, 14.99, 8, 7.99) | ForEach-Object { Get-PolicyForRemaining $_ }
    state = [ordered]@{
        policy = $state.currentPolicy
        reason = $state.reasonCode
        effective = $state.evidence.effectiveRemaining
        primary = $state.evidence.primaryRemaining
        secondary = $state.evidence.secondaryRemaining
    }
    override = @(
        (Test-OverridePrompt 'usage-guard: override once continue'),
        (Test-OverridePrompt 'README says usage-guard: override once')
    )
    classifications = @(
        (Get-ToolClassification (New-Event 'Agent')),
        (Get-ToolClassification (New-Event 'Bash' 'git status --short')),
        (Get-ToolClassification (New-Event 'Bash' 'rg --files')),
        (Get-ToolClassification (New-Event 'apply_patch' '*** Update File: docs/plan/progress.md'))
    ) | ForEach-Object { [ordered]@{ cost = $_.Cost; checkpointSafe = $_.CheckpointSafe; kind = $_.Kind } }
    resume = [ordered]@{
        eligible = $resume.Plan.eligible
        blockingWindows = @($resume.Plan.blockingWindows)
        blockingResetAt = $resume.Plan.blockingResetAt
        waitSeconds = $resume.Plan.waitSeconds
        status = $resume.Plan.status
    }
    sixHour = (Get-ResumePlanForState (Convert-UsageToState (New-UsageResponse 95 20 $exactReset ($nowUnix + 50000)) (New-DefaultState)) (New-Event '') $null).Plan.status
}

$snapshot | ConvertTo-Json -Depth 20 -Compress

