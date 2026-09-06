param(
    [switch]$NoMain
)

$ErrorActionPreference = 'Stop'
$script:UsageToolName = 'mcp__codex_app__get_usage_limits'
$script:AutomationToolName = 'mcp__codex_app__automation_update'
$script:FreshSeconds = 120
$script:StaleSeconds = 300
$script:QueryTimeoutSeconds = 10
$script:ResumeSafetySeconds = 180
$script:ResumeMaxWaitSeconds = 21600

function Get-UtcNow {
    if ($env:USAGE_GUARD_NOW_UTC) {
        return [DateTimeOffset]::Parse($env:USAGE_GUARD_NOW_UTC).ToUniversalTime()
    }
    return [DateTimeOffset]::UtcNow
}

function Get-Value {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function ConvertTo-SafeId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return 'unknown' }
    $safe = [regex]::Replace($Value, '[^A-Za-z0-9._-]', '_')
    if ($safe.Length -gt 120) { $safe = $safe.Substring(0, 120) }
    return $safe
}

function Get-DataRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:PLUGIN_DATA)) {
        return [System.IO.Path]::GetFullPath($env:PLUGIN_DATA)
    }
    return [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'codex-usage-guard')
}

function Get-StatePath {
    return [System.IO.Path]::Combine((Get-DataRoot), 'state.json')
}

function Get-TurnPath {
    param([string]$SessionId, [string]$TurnId)
    $session = ConvertTo-SafeId $SessionId
    $turn = ConvertTo-SafeId $TurnId
    return [System.IO.Path]::Combine((Get-DataRoot), 'turns', $session, "$turn.json")
}

function Read-JsonFile {
    param([string]$Path)
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return $raw | ConvertFrom-Json -Depth 40
    }
    catch {
        return $null
    }
}

function Write-JsonAtomic {
    param([string]$Path, $Value)
    $directory = [System.IO.Path]::GetDirectoryName($Path)
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    $json = $Value | ConvertTo-Json -Depth 40 -Compress
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    $lastError = $null
    foreach ($delay in @(0, 25, 75, 150)) {
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
        try {
            [System.IO.File]::Move($temporary, $Path, $true)
            return
        }
        catch {
            $lastError = $_
        }
    }
    if ([System.IO.File]::Exists($temporary)) {
        [System.IO.File]::Delete($temporary)
    }
    throw $lastError
}

function New-DefaultState {
    return [ordered]@{
        schemaVersion = 2
        lastSuccessfulAt = $null
        windows = [ordered]@{ primary = $null; secondary = $null }
        previousPolicy = $null
        currentPolicy = 'UNKNOWN'
        changedAt = $null
        reasonCode = 'NO_SNAPSHOT'
        reasonWindow = $null
        evidence = [ordered]@{ primaryRemaining = $null; secondaryRemaining = $null; effectiveRemaining = $null }
        stale = $false
        consecutiveFailures = 0
        resumePlan = [ordered]@{
            eligible = $false
            blockingWindows = @()
            blockingResetAt = $null
            wakeAt = $null
            waitSeconds = $null
            scheduleKey = $null
            status = 'NONE'
            automationId = $null
            lastError = $null
            updatedAt = $null
        }
        lastCleanupAt = $null
    }
}

function Get-State {
    $state = Read-JsonFile (Get-StatePath)
    if ($null -eq $state) { return New-DefaultState }
    return $state
}

function ConvertTo-Number {
    param($Value)
    if ($null -eq $Value) { return $null }
    $number = 0.0
    if ([double]::TryParse([string]$Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        return $number
    }
    return $null
}

function ConvertTo-Window {
    param($Window, [string]$Name)
    if ($null -eq $Window) { return $null }
    $used = ConvertTo-Number (Get-Value $Window 'usedPercent')
    if ($null -eq $used) { return $null }
    $used = [Math]::Max(0, [Math]::Min(100, $used))
    $remaining = [Math]::Round(100 - $used, 2)
    return [ordered]@{
        name = $Name
        usedPercent = $used
        remainingPercent = $remaining
        windowDurationMins = ConvertTo-Number (Get-Value $Window 'windowDurationMins')
        resetsAt = Get-Value $Window 'resetsAt'
    }
}

function Find-UsagePayload {
    param($Response)
    $queue = [System.Collections.ArrayList]::new()
    if ($null -ne $Response) { [void]$queue.Add($Response) }
    $seen = 0
    while ($queue.Count -gt 0 -and $seen -lt 30) {
        $seen++
        $candidate = $queue[0]
        $queue.RemoveAt(0)
        if ($env:USAGE_GUARD_DEBUG -eq '1') {
            [Console]::Error.WriteLine("[usage-guard] payload-step=$seen type=$($candidate.GetType().FullName) string=$($candidate -is [string])")
        }
        if ($candidate -is [string]) {
            try { [void]$queue.Add(($candidate | ConvertFrom-Json -Depth 40)) } catch { if ($env:USAGE_GUARD_DEBUG -eq '1') { [Console]::Error.WriteLine("[usage-guard] nested-json-error: $($_.Exception.Message)") } }
            continue
        }
        if ($null -ne (Get-Value $candidate 'rateLimits') -or $null -ne (Get-Value $candidate 'rateLimitsByLimitId')) {
            return $candidate
        }
        foreach ($name in @('structuredContent', 'result', 'data')) {
            $nested = Get-Value $candidate $name
            if ($null -ne $nested) { [void]$queue.Add($nested) }
        }
        $content = Get-Value $candidate 'content'
        if ($null -ne $content -and $content -isnot [string]) {
            foreach ($item in @($content)) {
                $text = Get-Value $item 'text'
                if ($null -ne $text) { [void]$queue.Add($text) }
            }
        }
    }
    return $null
}

function Get-PolicyForRemaining {
    param([double]$Remaining)
    if ($Remaining -lt 8) { return 'EMERGENCY' }
    if ($Remaining -lt 15) { return 'CRITICAL' }
    if ($Remaining -lt 30) { return 'CONSERVE' }
    return 'NORMAL'
}

function Get-ReasonCode {
    param([string]$Policy, [string]$Window)
    $prefix = if ($Window) { $Window.ToUpperInvariant() } else { 'EFFECTIVE' }
    switch ($Policy) {
        'EMERGENCY' { return "${prefix}_WINDOW_BELOW_8" }
        'CRITICAL' { return "${prefix}_WINDOW_BELOW_15" }
        'CONSERVE' { return "${prefix}_WINDOW_BELOW_30" }
        'NORMAL' { return 'ALL_WINDOWS_AT_OR_ABOVE_30' }
        default { return 'NO_VALID_WINDOWS' }
    }
}

function Convert-UsageToState {
    param($Response, $PreviousState)
    $payload = Find-UsagePayload $Response
    if ($null -eq $payload) { throw 'No usage payload found.' }
    $rateLimits = Get-Value $payload 'rateLimits'
    $byId = Get-Value $payload 'rateLimitsByLimitId'
    if ($null -ne $byId) {
        $codex = Get-Value $byId 'codex'
        if ($null -ne $codex) { $rateLimits = $codex }
    }
    if ($null -eq $rateLimits) { throw 'No Codex rate-limit object found.' }
    $primary = ConvertTo-Window (Get-Value $rateLimits 'primary') 'primary'
    $secondary = ConvertTo-Window (Get-Value $rateLimits 'secondary') 'secondary'
    $valid = @($primary, $secondary) | Where-Object { $null -ne $_ }
    if ($valid.Count -eq 0) { throw 'No valid usage windows found.' }
    $culprit = $valid | Sort-Object { $_.remainingPercent } | Select-Object -First 1
    $effective = [double]$culprit.remainingPercent
    $policy = Get-PolicyForRemaining $effective
    $previousPolicy = [string](Get-Value $PreviousState 'currentPolicy')
    if ([string]::IsNullOrWhiteSpace($previousPolicy)) { $previousPolicy = 'UNKNOWN' }
    $now = (Get-UtcNow).ToString('o')
    $oldChangedAt = Get-Value $PreviousState 'changedAt'
    $changedAt = if ($previousPolicy -ne $policy -or $null -eq $oldChangedAt) { $now } else { $oldChangedAt }
    return [ordered]@{
        schemaVersion = 2
        lastSuccessfulAt = $now
        windows = [ordered]@{ primary = $primary; secondary = $secondary }
        previousPolicy = $previousPolicy
        currentPolicy = $policy
        changedAt = $changedAt
        reasonCode = Get-ReasonCode $policy ([string]$culprit.name)
        reasonWindow = [string]$culprit.name
        evidence = [ordered]@{
            primaryRemaining = if ($null -ne $primary) { $primary.remainingPercent } else { $null }
            secondaryRemaining = if ($null -ne $secondary) { $secondary.remainingPercent } else { $null }
            effectiveRemaining = $effective
        }
        stale = $false
        consecutiveFailures = 0
        resumePlan = Get-Value $PreviousState 'resumePlan'
        lastCleanupAt = Get-Value $PreviousState 'lastCleanupAt'
    }
}

function New-ResumePlan {
    param(
        [bool]$Eligible = $false,
        [string[]]$BlockingWindows = @(),
        $BlockingResetAt = $null,
        $WakeAt = $null,
        $WaitSeconds = $null,
        $ScheduleKey = $null,
        [string]$Status = 'NONE',
        $AutomationId = $null,
        $LastError = $null
    )
    return [ordered]@{
        eligible = $Eligible
        blockingWindows = @($BlockingWindows)
        blockingResetAt = $BlockingResetAt
        wakeAt = $WakeAt
        waitSeconds = $WaitSeconds
        scheduleKey = $ScheduleKey
        status = $Status
        automationId = $AutomationId
        lastError = $LastError
        updatedAt = (Get-UtcNow).ToString('o')
    }
}

function Get-ResumePlanForState {
    param($State, $Event, $PreviousPlan)
    if ([string](Get-Value $State 'currentPolicy') -ne 'EMERGENCY' -or [bool](Get-Value $State 'stale')) {
        return [pscustomobject]@{ Plan = (New-ResumePlan); RequestCreated = $false }
    }

    $blocking = [System.Collections.ArrayList]::new()
    $resetValues = [System.Collections.ArrayList]::new()
    $windows = Get-Value $State 'windows'
    foreach ($name in @('primary', 'secondary')) {
        $window = Get-Value $windows $name
        $remaining = ConvertTo-Number (Get-Value $window 'remainingPercent')
        if ($null -ne $remaining -and $remaining -lt 8) {
            [void]$blocking.Add($name)
            $reset = ConvertTo-Number (Get-Value $window 'resetsAt')
            if ($null -eq $reset) {
                return [pscustomobject]@{
                    Plan = (New-ResumePlan -BlockingWindows @($blocking) -Status 'SKIPPED_INVALID_RESET')
                    RequestCreated = $false
                }
            }
            [void]$resetValues.Add([long][Math]::Floor($reset))
        }
    }

    if ($blocking.Count -eq 0) {
        return [pscustomobject]@{ Plan = (New-ResumePlan); RequestCreated = $false }
    }

    $now = Get-UtcNow
    $nowUnix = $now.ToUnixTimeSeconds()
    $blockingResetAt = [long](($resetValues | Measure-Object -Maximum).Maximum)
    $wakeAt = $blockingResetAt + $script:ResumeSafetySeconds
    $waitSeconds = $wakeAt - $nowUnix
    if ($blockingResetAt -le $nowUnix -or $waitSeconds -le 0) {
        return [pscustomobject]@{
            Plan = (New-ResumePlan -BlockingWindows @($blocking) -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -Status 'SKIPPED_INVALID_RESET')
            RequestCreated = $false
        }
    }

    $sessionId = ConvertTo-SafeId ([string](Get-Value $Event 'session_id'))
    $windowKey = (@($blocking) -join '+')
    $scheduleKey = "${sessionId}:${windowKey}:${wakeAt}"
    if ($waitSeconds -gt $script:ResumeMaxWaitSeconds) {
        return [pscustomobject]@{
            Plan = (New-ResumePlan -BlockingWindows @($blocking) -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -ScheduleKey $scheduleKey -Status 'SKIPPED_LONG_WAIT')
            RequestCreated = $false
        }
    }

    $previousKey = [string](Get-Value $PreviousPlan 'scheduleKey')
    $previousStatus = [string](Get-Value $PreviousPlan 'status')
    if ($previousKey -eq $scheduleKey -and $previousStatus -in @('REQUESTED', 'SCHEDULED', 'FAILED')) {
        return [pscustomobject]@{
            Plan = (New-ResumePlan -Eligible $true -BlockingWindows @($blocking) -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -ScheduleKey $scheduleKey -Status $previousStatus -AutomationId (Get-Value $PreviousPlan 'automationId') -LastError (Get-Value $PreviousPlan 'lastError'))
            RequestCreated = $false
        }
    }

    return [pscustomobject]@{
        Plan = (New-ResumePlan -Eligible $true -BlockingWindows @($blocking) -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -ScheduleKey $scheduleKey -Status 'REQUESTED')
        RequestCreated = $true
    }
}

function Get-ResumePlanContext {
    param($State, [bool]$RequestCreated)
    $plan = Get-Value $State 'resumePlan'
    $status = [string](Get-Value $plan 'status')
    if ($status -eq 'NONE' -or [string]::IsNullOrWhiteSpace($status)) { return '' }
    $wakeAt = ConvertTo-Number (Get-Value $plan 'wakeAt')
    $wakeIso = if ($null -ne $wakeAt) { [DateTimeOffset]::FromUnixTimeSeconds([long]$wakeAt).ToString('o') } else { 'unknown' }
    $key = [string](Get-Value $plan 'scheduleKey')
    if ($status -eq 'SKIPPED_LONG_WAIT') {
        return " Auto-resume skipped because wakeAt=$wakeIso is more than six hours away. Save a bounded checkpoint and report manual resume timing."
    }
    if ($status -eq 'SKIPPED_INVALID_RESET') {
        return ' Auto-resume skipped because a blocking reset time is missing or invalid. Save a bounded checkpoint and report manual resume guidance.'
    }
    if ($status -eq 'FAILED') {
        return " Auto-resume scheduling failed for scheduleKey=$key. Do not retry automatically; preserve a checkpoint and report manual resume guidance."
    }
    if ($status -eq 'SCHEDULED') {
        return " Auto-resume is already scheduled for wakeAt=$wakeIso scheduleKey=$key; do not create another heartbeat."
    }
    if ($RequestCreated) {
        return " AUTO-RESUME ACTION: create exactly one same-thread heartbeat with $script:AutomationToolName for wakeAt=$wakeIso scheduleKey=$key. Name it 'Usage Guard resume'. Its prompt must refresh Usage Guard, continue from the existing checkpoint only after leaving EMERGENCY, obey the new policy, stay quiet if still blocked, and pause itself after its recovery run. If the tool is unavailable, report that once and stop after checkpointing."
    }
    return " Auto-resume was already requested for wakeAt=$wakeIso scheduleKey=$key; do not request a duplicate."
}

function Invoke-RateLimitQuery {
    if (-not [string]::IsNullOrWhiteSpace($env:USAGE_GUARD_TEST_RESPONSE_PATH)) {
        $testResponse = Read-JsonFile $env:USAGE_GUARD_TEST_RESPONSE_PATH
        if ($null -eq $testResponse) { throw 'Usage Guard test response is unavailable.' }
        return $testResponse
    }

    $codex = Get-Command 'codex.exe' -ErrorAction SilentlyContinue
    if ($null -eq $codex) { throw 'codex.exe is unavailable.' }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $codex.Source
    $startInfo.ArgumentList.Add('app-server')
    $startInfo.ArgumentList.Add('--stdio')
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Could not start codex app-server.' }
    $stderrTask = $process.StandardError.ReadToEndAsync()

    try {
        $requests = @(
            @{ id = 1; method = 'initialize'; params = @{ clientInfo = @{ name = 'usage-guard'; version = '0.1.0' }; capabilities = @{ experimentalApi = $true } } },
            @{ method = 'initialized' },
            @{ id = 2; method = 'account/rateLimits/read'; params = $null }
        )
        foreach ($request in $requests) {
            $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 10 -Compress))
            $process.StandardInput.Flush()
        }

        $deadline = [DateTimeOffset]::UtcNow.AddSeconds($script:QueryTimeoutSeconds)
        $readTask = $process.StandardOutput.ReadLineAsync()
        while ([DateTimeOffset]::UtcNow -lt $deadline) {
            if (-not $readTask.Wait(250)) { continue }
            $line = $readTask.Result
            if ($null -eq $line) { break }
            try { $message = $line | ConvertFrom-Json -Depth 40 } catch { $message = $null }
            if ($null -ne $message -and (Get-Value $message 'id') -eq 2) {
                $errorValue = Get-Value $message 'error'
                if ($null -ne $errorValue) {
                    throw "account/rateLimits/read failed: $($errorValue | ConvertTo-Json -Depth 10 -Compress)"
                }
                $result = Get-Value $message 'result'
                if ($null -eq $result) { throw 'account/rateLimits/read returned no result.' }
                return $result
            }
            $readTask = $process.StandardOutput.ReadLineAsync()
        }
        throw 'Timed out waiting for account/rateLimits/read.'
    }
    finally {
        try { $process.StandardInput.Close() } catch { }
        if (-not $process.HasExited) {
            try { $process.Kill($true) } catch { }
            try { $process.WaitForExit(3000) | Out-Null } catch { }
        }
        try { [void]$stderrTask.Wait(1000) } catch { }
        $process.Dispose()
    }
}

function Get-SnapshotAgeSeconds {
    param($State)
    $value = Get-Value $State 'lastSuccessfulAt'
    if ([string]::IsNullOrWhiteSpace([string]$value)) { return [double]::PositiveInfinity }
    try { return ((Get-UtcNow) - [DateTimeOffset]::Parse([string]$value)).TotalSeconds } catch { return [double]::PositiveInfinity }
}

function Register-UsageFailure {
    param($State)
    if ($null -eq $State) { $State = New-DefaultState }
    $failures = ConvertTo-Number (Get-Value $State 'consecutiveFailures')
    if ($null -eq $failures) { $failures = 0 }
    $State.consecutiveFailures = [int]$failures + 1
    if ((Get-SnapshotAgeSeconds $State) -le $script:StaleSeconds) {
        $State.stale = $true
    }
    else {
        $State.previousPolicy = Get-Value $State 'currentPolicy'
        $State.currentPolicy = 'UNKNOWN'
        $State.reasonCode = 'QUERY_FAILED_NO_CACHE'
        $State.reasonWindow = $null
        $State.stale = $false
        $State.changedAt = (Get-UtcNow).ToString('o')
    }
    return $State
}

function Get-PolicySummary {
    param($State)
    if ($null -eq $State) { return 'state=UNKNOWN reason=NO_SNAPSHOT' }
    $policy = [string](Get-Value $State 'currentPolicy')
    $reason = [string](Get-Value $State 'reasonCode')
    $evidence = Get-Value $State 'evidence'
    $effective = Get-Value $evidence 'effectiveRemaining'
    $suffix = if ($null -ne $effective) { " remaining=$effective%" } else { '' }
    if ([bool](Get-Value $State 'stale')) { $suffix += ' STALE' }
    return "state=$policy reason=$reason$suffix"
}

function New-ContextOutput {
    param([string]$EventName, [string]$Text, [string]$SystemMessage = $null)
    $output = [ordered]@{}
    if ($SystemMessage) { $output.systemMessage = $SystemMessage }
    $output.hookSpecificOutput = [ordered]@{
        hookEventName = $EventName
        additionalContext = $Text
    }
    return $output
}

function New-DenyOutput {
    param([string]$Reason)
    return [ordered]@{
        hookSpecificOutput = [ordered]@{
            hookEventName = 'PreToolUse'
            permissionDecision = 'deny'
            permissionDecisionReason = $Reason
        }
    }
}

function Get-ToolCommandText {
    param($Event)
    $input = Get-Value $Event 'tool_input'
    $command = Get-Value $input 'command'
    if ($null -eq $command) { return ($input | ConvertTo-Json -Depth 10 -Compress) }
    return [string]$command
}

function Get-ToolClassification {
    param($Event)
    $name = [string](Get-Value $Event 'tool_name')
    $command = Get-ToolCommandText $Event
    $lowerName = $name.ToLowerInvariant()
    $checkpointSafe = $false
    $cost = 'UNKNOWN'

    if ($name -eq $script:UsageToolName) { return [pscustomobject]@{ Cost = 'LOW'; CheckpointSafe = $true; Kind = 'usage' } }
    if ($name -eq $script:AutomationToolName) { return [pscustomobject]@{ Cost = 'LOW'; CheckpointSafe = $true; Kind = 'resume-automation' } }
    if ($name -eq 'Agent' -or $lowerName -match 'spawn_agent|imagegen|image_gen|video') { return [pscustomobject]@{ Cost = 'HIGH'; CheckpointSafe = $false; Kind = 'expansion' } }
    if ($lowerName -match '^mcp__') {
        $cost = if ($lowerName -match 'search|browser|generate|bulk|crawl|scan') { 'HIGH' } else { 'MEDIUM' }
        return [pscustomobject]@{ Cost = $cost; CheckpointSafe = $false; Kind = 'mcp' }
    }
    if ($name -eq 'apply_patch' -or $name -eq 'Edit' -or $name -eq 'Write') {
        $checkpointSafe = $command -match '(?i)(docs[\\/]plan|task_plan\.md|progress\.md|findings\.md|checkpoint|state\.md)'
        return [pscustomobject]@{ Cost = 'MEDIUM'; CheckpointSafe = $checkpointSafe; Kind = 'edit' }
    }
    if ($name -eq 'Bash' -or $lowerName -eq 'exec_command') {
        if ($command -match '(?i)^\s*git\s+(status|diff)(\s|$)') { return [pscustomobject]@{ Cost = 'LOW'; CheckpointSafe = $true; Kind = 'status' } }
        if ($command -match '(?i)(--watch|--parallel|--all\b|\s-j\s*\d*|benchmark|dependency|\binstall\b|\brestore\b|\b(build|test)\b.*(--all|--parallel)|rg\s+--files|Get-ChildItem.*-Recurse)') {
            return [pscustomobject]@{ Cost = 'HIGH'; CheckpointSafe = $false; Kind = 'bulk-shell' }
        }
        $checkpointSafe = $command -match '(?i)(Get-Content|type\s+).*(task_plan|progress|findings|checkpoint|state)'
        return [pscustomobject]@{ Cost = 'MEDIUM'; CheckpointSafe = $checkpointSafe; Kind = 'shell' }
    }
    if ($lowerName -match 'read|view|get_file|open_file') {
        $checkpointSafe = $command -match '(?i)(task_plan|progress|findings|checkpoint|state|git)'
        return [pscustomobject]@{ Cost = 'LOW'; CheckpointSafe = $checkpointSafe; Kind = 'read' }
    }
    return [pscustomobject]@{ Cost = $cost; CheckpointSafe = $checkpointSafe; Kind = 'unknown' }
}

function Test-OverridePrompt {
    param([string]$Prompt)
    if ($null -eq $Prompt) { return $false }
    return $Prompt -match '(?i)^\s*usage-guard: override once(?:\s|$)'
}

function New-TurnRecord {
    param($Event)
    return [ordered]@{
        sessionId = [string](Get-Value $Event 'session_id')
        turnId = [string](Get-Value $Event 'turn_id')
        createdAt = (Get-UtcNow).ToString('o')
        usageAttempted = $false
        usageChecked = $false
        effectivePolicy = 'UNKNOWN'
        overrideOnce = Test-OverridePrompt ([string](Get-Value $Event 'prompt'))
        stopContinuationRequested = $false
        resumeScheduleAttempted = $false
        resumeContinuationRequested = $false
        resumeScheduleKey = $null
    }
}

function Get-TurnRecord {
    param($Event)
    return Read-JsonFile (Get-TurnPath ([string](Get-Value $Event 'session_id')) ([string](Get-Value $Event 'turn_id')))
}

function Save-TurnRecord {
    param($Event, $Record)
    Write-JsonAtomic (Get-TurnPath ([string](Get-Value $Event 'session_id')) ([string](Get-Value $Event 'turn_id'))) $Record
}

function Update-UsageSnapshot {
    param($Event, $Turn = $null)
    $state = Get-State
    if ($null -eq $Turn) { $Turn = Get-TurnRecord $Event }
    if ($null -eq $Turn) { $Turn = New-TurnRecord $Event }
    $Turn.usageAttempted = $true
    try {
        $previousPlan = Get-Value $state 'resumePlan'
        $state = Convert-UsageToState (Invoke-RateLimitQuery) $state
        $resume = Get-ResumePlanForState $state $Event $previousPlan
        $state.resumePlan = $resume.Plan
        $Turn.usageChecked = $true
        $Turn.effectivePolicy = $state.currentPolicy
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $Turn
        return [pscustomobject]@{ Succeeded = $true; State = $state; Turn = $Turn; Error = $null; ResumeRequestCreated = $resume.RequestCreated }
    }
    catch {
        [Console]::Error.WriteLine("[usage-guard] quota query failed: $($_.Exception.Message)")
        $state = Register-UsageFailure $state
        $Turn.usageChecked = $false
        $Turn.effectivePolicy = $state.currentPolicy
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $Turn
        return [pscustomobject]@{ Succeeded = $false; State = $state; Turn = $Turn; Error = $_.Exception.Message; ResumeRequestCreated = $false }
    }
}

function Test-MatchingResumeAutomation {
    param($Event, $State)
    $plan = Get-Value $State 'resumePlan'
    if (-not [bool](Get-Value $plan 'eligible')) { return $false }
    $key = [string](Get-Value $plan 'scheduleKey')
    if ([string]::IsNullOrWhiteSpace($key)) { return $false }
    $inputText = Get-ToolCommandText $Event
    return $inputText.Contains($key, [StringComparison]::Ordinal) -and $inputText -match '(?i)usage[ -]guard'
}

function Remove-ExpiredTurns {
    $turns = [System.IO.Path]::Combine((Get-DataRoot), 'turns')
    if (-not [System.IO.Directory]::Exists($turns)) { return }
    $cutoff = (Get-UtcNow).UtcDateTime.AddDays(-7)
    foreach ($file in [System.IO.Directory]::EnumerateFiles($turns, '*.json', [IO.SearchOption]::AllDirectories)) {
        try { if ([System.IO.File]::GetLastWriteTimeUtc($file) -lt $cutoff) { [System.IO.File]::Delete($file) } } catch { }
    }
}

function Invoke-PreToolPolicy {
    param($Event)
    $classification = Get-ToolClassification $Event
    if ($classification.Kind -eq 'usage') { return @{} }
    $turn = Get-TurnRecord $Event
    if ($null -ne $turn -and [bool](Get-Value $turn 'overrideOnce')) {
        return New-ContextOutput 'PreToolUse' 'Usage Guard one-turn override is active. Continue deliberately; usage warnings still apply.'
    }
    if ($null -eq $turn -or (-not [bool](Get-Value $turn 'usageAttempted') -and -not [bool](Get-Value $turn 'usageChecked'))) {
        $refresh = Update-UsageSnapshot $Event $turn
        $turn = $refresh.Turn
    }
    $state = Get-State
    $policy = [string](Get-Value $state 'currentPolicy')
    if ([string]::IsNullOrWhiteSpace($policy)) { $policy = 'UNKNOWN' }
    if ($classification.Kind -eq 'resume-automation') {
        if ($policy -ne 'EMERGENCY') { return @{} }
        if (-not (Test-MatchingResumeAutomation $Event $state)) {
            return New-DenyOutput 'Usage Guard EMERGENCY permits only the heartbeat matching the current recovery schedule key.'
        }
        $turn.resumeScheduleAttempted = $true
        $turn.resumeScheduleKey = Get-Value (Get-Value $state 'resumePlan') 'scheduleKey'
        Save-TurnRecord $Event $turn
        return New-ContextOutput 'PreToolUse' 'Usage Guard permits this matching bounded auto-resume heartbeat operation.'
    }
    if ($policy -eq 'UNKNOWN') {
        return New-ContextOutput 'PreToolUse' 'Usage state is UNKNOWN; fail-open is active. Continue cautiously and preserve a checkpoint after repeated failures.' 'Usage Guard could not read quota and is failing open.'
    }
    if ($classification.Cost -eq 'HIGH' -and (Get-SnapshotAgeSeconds $state) -gt $script:FreshSeconds) {
        $refresh = Update-UsageSnapshot $Event $turn
        $state = $refresh.State
        if (-not $refresh.Succeeded -and [string](Get-Value $state 'currentPolicy') -eq 'UNKNOWN') {
            return New-ContextOutput 'PreToolUse' 'Usage refresh failed before high-cost work; fail-open is active. Continue cautiously and preserve a bounded checkpoint.' 'Usage Guard could not refresh quota and is failing open.'
        }
    }
    switch ($policy) {
        'NORMAL' { return @{} }
        'CONSERVE' {
            if ($classification.Kind -eq 'expansion') { return New-DenyOutput 'Usage Guard CONSERVE blocks new subagents and generated-media expansion.' }
            return New-ContextOutput 'PreToolUse' "Usage Guard CONSERVE: $((Get-PolicySummary $state)). Keep scope narrow."
        }
        'CRITICAL' {
            if ($classification.Cost -eq 'HIGH') { return New-DenyOutput "Usage Guard CRITICAL blocks high-cost work: $((Get-PolicySummary $state))." }
            return New-ContextOutput 'PreToolUse' "Usage Guard CRITICAL: finish only the smallest necessary step; $((Get-PolicySummary $state))."
        }
        'EMERGENCY' {
            if (-not $classification.CheckpointSafe) { return New-DenyOutput "Usage Guard EMERGENCY allows only bounded checkpoint, status, and reporting operations: $((Get-PolicySummary $state))." }
            return New-ContextOutput 'PreToolUse' 'Usage Guard EMERGENCY: this bounded checkpoint operation is allowed; do not expand its scope.'
        }
        default { return @{} }
    }
}

function Invoke-UsagePostTool {
    param($Event)
    $state = Get-State
    $turn = Get-TurnRecord $Event
    if ($null -eq $turn) { $turn = New-TurnRecord $Event }
    $turn.usageAttempted = $true
    try {
        $toolResponse = Get-Value $Event 'tool_response'
        if ($env:USAGE_GUARD_DEBUG -eq '1') {
            [Console]::Error.WriteLine("[usage-guard] response-shape: $($toolResponse | ConvertTo-Json -Depth 8 -Compress)")
        }
        $previousPlan = Get-Value $state 'resumePlan'
        $state = Convert-UsageToState $toolResponse $state
        $resume = Get-ResumePlanForState $state $Event $previousPlan
        $state.resumePlan = $resume.Plan
        $turn.usageChecked = $true
        $turn.effectivePolicy = $state.currentPolicy
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $turn
        return New-ContextOutput 'PostToolUse' "Usage Guard updated: $((Get-PolicySummary $state)). This is a tool policy, not a work-capacity estimate.$(Get-ResumePlanContext $state $resume.RequestCreated)"
    }
    catch {
        [Console]::Error.WriteLine("[usage-guard] quota processing failed: $($_.Exception.Message)")
        $state = Register-UsageFailure $state
        $turn.usageChecked = $false
        $turn.effectivePolicy = $state.currentPolicy
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $turn
        $checkpoint = if ([int](Get-Value $state 'consecutiveFailures') -ge 3) { ' Create a bounded recovery checkpoint before substantial work.' } else { '' }
        return New-ContextOutput 'PostToolUse' "Usage Guard could not parse quota; fail-open is active. $((Get-PolicySummary $state)).$checkpoint" 'Usage Guard quota query failed; work remains available.'
    }
}

function Find-AutomationResult {
    param($Response)
    $queue = [System.Collections.ArrayList]::new()
    if ($null -ne $Response) { [void]$queue.Add($Response) }
    $seen = 0
    while ($queue.Count -gt 0 -and $seen -lt 40) {
        $seen++
        $candidate = $queue[0]
        $queue.RemoveAt(0)
        if ($candidate -is [string]) {
            try { [void]$queue.Add(($candidate | ConvertFrom-Json -Depth 40)) } catch { }
            continue
        }
        $automationId = Get-Value $candidate 'automationId'
        $id = Get-Value $candidate 'id'
        $status = [string](Get-Value $candidate 'status')
        $successStatus = $status -match '(?i)^(created|updated|active|scheduled|success|ok)$'
        if ($null -ne $automationId -or $successStatus) {
            return $candidate
        }
        foreach ($name in @('structuredContent', 'result', 'data', 'output')) {
            $nested = Get-Value $candidate $name
            if ($null -ne $nested) { [void]$queue.Add($nested) }
        }
        $content = Get-Value $candidate 'content'
        if ($null -ne $content -and $content -isnot [string]) {
            foreach ($item in @($content)) {
                $text = Get-Value $item 'text'
                if ($null -ne $text) { [void]$queue.Add($text) }
            }
        }
    }
    return $null
}

function Get-BoundedErrorText {
    param($Value)
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return 'Unknown automation error.' }
    $text = [regex]::Replace($text, '\s+', ' ').Trim()
    if ($text.Length -gt 240) { return $text.Substring(0, 240) }
    return $text
}

function Invoke-AutomationPostTool {
    param($Event)
    $state = Get-State
    $turn = Get-TurnRecord $Event
    if ($null -eq $turn) { $turn = New-TurnRecord $Event }
    $turn.resumeScheduleAttempted = $true
    $plan = Get-Value $state 'resumePlan'
    if ($null -eq $plan) { $plan = New-ResumePlan }
    try {
        $response = Get-Value $Event 'tool_response'
        if ((Get-Value $response 'isError') -eq $true) { throw 'Automation tool reported an error.' }
        $result = Find-AutomationResult $response
        if ($null -eq $result) { throw 'Automation tool returned no creation or update result.' }
        $automationId = Get-Value $result 'automationId'
        if ($null -eq $automationId) { $automationId = Get-Value $result 'id' }
        $plan.status = 'SCHEDULED'
        $plan.automationId = $automationId
        $plan.lastError = $null
        $plan.updatedAt = (Get-UtcNow).ToString('o')
        $state.resumePlan = $plan
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $turn
        return New-ContextOutput 'PostToolUse' "Usage Guard auto-resume scheduled for scheduleKey=$([string](Get-Value $plan 'scheduleKey')). Do not create another heartbeat."
    }
    catch {
        $plan.status = 'FAILED'
        $plan.lastError = Get-BoundedErrorText $_.Exception.Message
        $plan.updatedAt = (Get-UtcNow).ToString('o')
        $state.resumePlan = $plan
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $turn
        return New-ContextOutput 'PostToolUse' "Usage Guard auto-resume scheduling failed. Preserve a bounded checkpoint and use manual resume; do not retry automatically." 'Usage Guard could not schedule auto-resume.'
    }
}

function Invoke-HookEvent {
    param($Event)
    $eventName = [string](Get-Value $Event 'hook_event_name')
    switch ($eventName) {
        'SessionStart' {
            Remove-ExpiredTurns
            $state = Get-State
            return New-ContextOutput 'SessionStart' "Usage Guard is active and queries Codex usage automatically on each user turn. $((Get-PolicySummary $state))."
        }
        'UserPromptSubmit' {
            $turn = New-TurnRecord $Event
            $refresh = Update-UsageSnapshot $Event $turn
            $state = $refresh.State
            $override = if ($turn.overrideOnce) { ' One-turn override is bound to this session and turn.' } else { '' }
            if ($refresh.Succeeded) {
                $resumeContext = Get-ResumePlanContext $state $refresh.ResumeRequestCreated
                return New-ContextOutput 'UserPromptSubmit' "Usage Guard checked automatically: $((Get-PolicySummary $state)). Treat this as tool policy, not a work-capacity estimate.$resumeContext$override"
            }
            $checkpoint = if ([int](Get-Value $state 'consecutiveFailures') -ge 3) { ' Create a bounded recovery checkpoint before substantial work.' } else { '' }
            return New-ContextOutput 'UserPromptSubmit' "Usage Guard query failed; fail-open is active. $((Get-PolicySummary $state)).$checkpoint$override" 'Usage Guard could not read quota; work remains available.'
        }
        'PreToolUse' { return Invoke-PreToolPolicy $Event }
        'PostToolUse' {
            $toolName = [string](Get-Value $Event 'tool_name')
            if ($toolName -eq $script:AutomationToolName) { return Invoke-AutomationPostTool $Event }
            return Invoke-UsagePostTool $Event
        }
        'SubagentStart' {
            $state = Get-State
            return New-ContextOutput 'SubagentStart' "Usage Guard applies inside this subagent. $((Get-PolicySummary $state)). Converge when the assigned task is complete."
        }
        'PreCompact' { return @{ systemMessage = "Usage Guard state preserved: $((Get-PolicySummary (Get-State)))." } }
        'PostCompact' { return @{ systemMessage = "Usage Guard state restored: $((Get-PolicySummary (Get-State)))." } }
        'Stop' {
            if ([bool](Get-Value $Event 'stop_hook_active')) { return @{} }
            $state = Get-State
            $plan = Get-Value $state 'resumePlan'
            $turn = Get-TurnRecord $Event
            if ($null -eq $turn) { return @{} }
            $eligible = [bool](Get-Value $plan 'eligible')
            $status = [string](Get-Value $plan 'status')
            $attempted = [bool](Get-Value $turn 'resumeScheduleAttempted')
            $continued = [bool](Get-Value $turn 'resumeContinuationRequested')
            if ($eligible -and $status -eq 'REQUESTED' -and -not $attempted -and -not $continued) {
                $turn.resumeContinuationRequested = $true
                Save-TurnRecord $Event $turn
                $wakeAt = [long](ConvertTo-Number (Get-Value $plan 'wakeAt'))
                $wakeIso = [DateTimeOffset]::FromUnixTimeSeconds($wakeAt).ToString('o')
                $key = [string](Get-Value $plan 'scheduleKey')
                return [ordered]@{ decision = 'block'; reason = "Attempt the one Usage Guard same-thread heartbeat now with $script:AutomationToolName for wakeAt=$wakeIso scheduleKey=$key. If the tool is unavailable, report that once, preserve the checkpoint, and stop; do not retry." }
            }
            return @{}
        }
        'SessionEnd' { Remove-ExpiredTurns; return @{} }
        default { return @{} }
    }
}

function Write-HookJson {
    param($Value)
    if ($null -eq $Value) { $Value = @{} }
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 40 -Compress))
}

function Invoke-UsageGuardMain {
    try {
        $raw = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($raw)) { Write-HookJson @{}; return }
        $event = $raw | ConvertFrom-Json -Depth 40
        Write-HookJson (Invoke-HookEvent $event)
    }
    catch {
        [Console]::Error.WriteLine("[usage-guard] $($_.Exception.Message)")
        Write-HookJson @{ systemMessage = 'Usage Guard failed safely; quota enforcement is disabled for this event.' }
    }
}

if (-not $NoMain) {
    Invoke-UsageGuardMain
}
