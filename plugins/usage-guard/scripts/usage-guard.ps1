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
$script:CheckpointRelativePath = [System.IO.Path]::Combine('docs', 'plan', 'usage-guard-checkpoint.json')

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

function Get-ContinuationPath {
    param([string]$SessionId)
    return [System.IO.Path]::Combine((Get-DataRoot), 'sessions', "$(ConvertTo-SafeId $SessionId).json")
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
        windowRoles = [ordered]@{ short = $null; weekly = $null }
        windowRoleErrors = @()
        previousPolicy = $null
        previousAction = $null
        currentPolicy = 'UNKNOWN'
        shortPolicy = 'UNKNOWN'
        weeklyPolicy = 'UNKNOWN'
        policyAction = 'UNKNOWN'
        changedAt = $null
        reasonCode = 'NO_SNAPSHOT'
        reasonWindow = $null
        evidence = [ordered]@{ primaryRemaining = $null; secondaryRemaining = $null; effectiveRemaining = $null; shortRemaining = $null; weeklyRemaining = $null }
        stale = $false
        consecutiveFailures = 0
        resumePlan = [ordered]@{
            eligible = $false
            blockingWindows = @()
            blockingResetAt = $null
            wakeAt = $null
            waitSeconds = $null
            scheduleKey = $null
            cycleId = 0
            resumeMode = 'continue'
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
    $duration = ConvertTo-Number (Get-Value $Window 'windowDurationMins')
    $role = if ($duration -eq 300) { 'short' } elseif ($duration -eq 10080) { 'weekly' } else { $null }
    $remaining = [Math]::Round(100 - $used, 2)
    return [ordered]@{
        name = $Name
        usedPercent = $used
        remainingPercent = $remaining
        windowDurationMins = $duration
        role = $role
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

function Get-WeeklyPolicyForRemaining {
    param([double]$Remaining)
    if ($Remaining -lt 5) { return 'STOP' }
    if ($Remaining -lt 8) { return 'FINALIZE' }
    if ($Remaining -lt 15) { return 'LOW' }
    return 'HEALTHY'
}

function Get-PolicySeverity {
    param([string]$Policy)
    $map = @{ NORMAL = 0; HEALTHY = 0; CONSERVE = 1; LOW = 1; CRITICAL = 2; FINALIZE = 2; EMERGENCY = 3; STOP = 4 }
    if ($map.ContainsKey($Policy)) { return $map[$Policy] }
    return -1
}

function Get-CombinedPolicy {
    param([string]$ShortPolicy, [string]$WeeklyPolicy, [string]$Fallback = 'UNKNOWN')
    $weeklyEquivalent = @{ HEALTHY = 'NORMAL'; LOW = 'CONSERVE'; FINALIZE = 'CRITICAL'; STOP = 'EMERGENCY' }[$WeeklyPolicy]
    $candidates = @($ShortPolicy, $weeklyEquivalent, $Fallback) | Where-Object { $_ -and $_ -ne 'UNKNOWN' }
    if ($candidates.Count -eq 0) { return 'UNKNOWN' }
    return ($candidates | Sort-Object { Get-PolicySeverity $_ } -Descending | Select-Object -First 1)
}

function Get-PolicyAction {
    param([string]$ShortPolicy, [string]$WeeklyPolicy, [string[]]$RoleErrors = @())
    if ($RoleErrors.Count -gt 0) { return 'UNKNOWN_WINDOW_ROLE' }
    if ($WeeklyPolicy -eq 'STOP') { return 'WEEKLY_STOP' }
    if ($ShortPolicy -eq 'EMERGENCY') { return 'SHORT_SUSPEND' }
    if ($WeeklyPolicy -eq 'FINALIZE') { return 'WEEKLY_FINALIZE' }
    if ($ShortPolicy -eq 'CRITICAL') { return 'SHORT_CRITICAL' }
    if ($WeeklyPolicy -eq 'LOW') { return 'WEEKLY_LOW' }
    if ($ShortPolicy -eq 'CONSERVE') { return 'SHORT_CONSERVE' }
    if ($ShortPolicy -eq 'NORMAL' -and $WeeklyPolicy -eq 'HEALTHY') { return 'RUN' }
    return 'UNKNOWN'
}

function Get-WindowRoles {
    param($Windows)
    $roles = [ordered]@{ short = $null; weekly = $null }
    $errors = [System.Collections.ArrayList]::new()
    foreach ($name in @('primary', 'secondary')) {
        $role = [string](Get-Value (Get-Value $Windows $name) 'role')
        if ([string]::IsNullOrWhiteSpace($role)) { continue }
        if ($roles[$role]) { [void]$errors.Add("DUPLICATE_$($role.ToUpperInvariant())_WINDOW") }
        elseif ($roles.Contains($role)) { $roles[$role] = $name }
    }
    foreach ($role in @('short', 'weekly')) { if (-not $roles[$role]) { [void]$errors.Add("MISSING_$($role.ToUpperInvariant())_WINDOW") } }
    return [pscustomobject]@{ Roles = $roles; Errors = @($errors) }
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
    $windows = [ordered]@{ primary = $primary; secondary = $secondary }
    $valid = @($primary, $secondary) | Where-Object { $null -ne $_ }
    if ($valid.Count -eq 0) { throw 'No valid usage windows found.' }
    $culprit = $valid | Sort-Object { $_.remainingPercent } | Select-Object -First 1
    $effective = [double]$culprit.remainingPercent
    $roleInfo = Get-WindowRoles $windows
    $shortWindow = if ($roleInfo.Roles.short) { Get-Value $windows $roleInfo.Roles.short } else { $null }
    $weeklyWindow = if ($roleInfo.Roles.weekly) { Get-Value $windows $roleInfo.Roles.weekly } else { $null }
    $shortPolicy = if ($null -ne $shortWindow) { Get-PolicyForRemaining $shortWindow.remainingPercent } else { 'UNKNOWN' }
    $weeklyPolicy = if ($null -ne $weeklyWindow) { Get-WeeklyPolicyForRemaining $weeklyWindow.remainingPercent } else { 'UNKNOWN' }
    $policy = Get-CombinedPolicy $shortPolicy $weeklyPolicy (Get-PolicyForRemaining $effective)
    $action = Get-PolicyAction $shortPolicy $weeklyPolicy $roleInfo.Errors
    $previousPolicy = [string](Get-Value $PreviousState 'currentPolicy')
    if ([string]::IsNullOrWhiteSpace($previousPolicy)) { $previousPolicy = 'UNKNOWN' }
    $previousAction = [string](Get-Value $PreviousState 'policyAction')
    if ([string]::IsNullOrWhiteSpace($previousAction)) { $previousAction = 'UNKNOWN' }
    $now = (Get-UtcNow).ToString('o')
    $oldChangedAt = Get-Value $PreviousState 'changedAt'
    $changedAt = if ($previousPolicy -ne $policy -or $previousAction -ne $action -or $null -eq $oldChangedAt) { $now } else { $oldChangedAt }
    return [ordered]@{
        schemaVersion = 2
        lastSuccessfulAt = $now
        windows = $windows
        windowRoles = $roleInfo.Roles
        windowRoleErrors = $roleInfo.Errors
        previousPolicy = $previousPolicy
        previousAction = $previousAction
        currentPolicy = $policy
        shortPolicy = $shortPolicy
        weeklyPolicy = $weeklyPolicy
        policyAction = $action
        changedAt = $changedAt
        reasonCode = if ($roleInfo.Errors.Count -gt 0) { [string]$roleInfo.Errors[0] } else { Get-ReasonCode $policy ([string]$culprit.name) }
        reasonWindow = [string]$culprit.name
        reasonRole = [string](Get-Value $culprit 'role')
        evidence = [ordered]@{
            primaryRemaining = if ($null -ne $primary) { $primary.remainingPercent } else { $null }
            secondaryRemaining = if ($null -ne $secondary) { $secondary.remainingPercent } else { $null }
            effectiveRemaining = $effective
            shortRemaining = if ($null -ne $shortWindow) { $shortWindow.remainingPercent } else { $null }
            weeklyRemaining = if ($null -ne $weeklyWindow) { $weeklyWindow.remainingPercent } else { $null }
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
        $CycleId = 0,
        [string]$ResumeMode = 'continue',
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
        cycleId = $CycleId
        resumeMode = $ResumeMode
        status = $Status
        automationId = $AutomationId
        lastError = $LastError
        updatedAt = (Get-UtcNow).ToString('o')
    }
}

function Test-ActiveResumePlan {
    param($Plan)
    return [bool](Get-Value $Plan 'eligible') -and [string](Get-Value $Plan 'status') -in @('REQUESTED', 'SCHEDULED', 'FAILED')
}

function Get-ResumePlanForState {
    param($State, $Event, $PreviousPlan, $Pause = $null, $Continuation = $null)
    $previous = if ($null -ne $PreviousPlan) { $PreviousPlan } else { New-ResumePlan }
    $taskStatus = [string](Get-Value $Continuation 'taskStatus')
    if ($taskStatus -in @('COMPLETED', 'CANCELLED', 'WAITING_USER', 'WEEKLY_STOPPED')) {
        return [pscustomobject]@{ Plan = if (Test-ActiveResumePlan $previous) { New-ResumePlan -Status 'CANCELLED' } else { $previous }; RequestCreated = $false }
    }
    $weekly = [string](Get-Value $State 'weeklyPolicy')
    $short = [string](Get-Value $State 'shortPolicy')
    $roleErrors = @(Get-Value $State 'windowRoleErrors')
    if ($weekly -eq 'STOP') { return [pscustomobject]@{ Plan = (New-ResumePlan -Status 'WEEKLY_STOPPED' -ResumeMode 'finalize_only'); RequestCreated = $false } }
    if ([bool](Get-Value $State 'stale')) { return [pscustomobject]@{ Plan = if (Test-ActiveResumePlan $previous) { $previous } else { New-ResumePlan }; RequestCreated = $false } }
    if ($roleErrors.Count -gt 0) { return [pscustomobject]@{ Plan = if (Test-ActiveResumePlan $previous) { $previous } else { New-ResumePlan -Status 'SKIPPED_INVALID_WINDOW_ROLE' }; RequestCreated = $false } }

    $legacyPause = [bool](Get-Value $Pause 'pauseCandidate') -and [bool](Get-Value $Pause 'checkpointObserved') -and [string](Get-Value $Pause 'pauseReason') -eq 'usage_guard'
    $pauseReason = if ($legacyPause) { 'short_window' } else { [string](Get-Value $Continuation 'pauseReason') }
    if ($pauseReason -eq 'weekly_budget') { return [pscustomobject]@{ Plan = (New-ResumePlan -Status $(if ($weekly -eq 'STOP') { 'WEEKLY_STOPPED' } else { 'WEEKLY_FINALIZE' }) -ResumeMode 'finalize_only'); RequestCreated = $false } }
    $shortPause = $pauseReason -in @('short_window', 'plugin_pause') -or $legacyPause
    $shouldSchedule = $short -eq 'EMERGENCY' -or $shortPause
    if ($weekly -eq 'FINALIZE' -and -not $shouldSchedule) { return [pscustomobject]@{ Plan = (New-ResumePlan -Status 'WEEKLY_FINALIZE' -ResumeMode 'finalize_only'); RequestCreated = $false } }
    if (-not $shouldSchedule) { return [pscustomobject]@{ Plan = if (Test-ActiveResumePlan $previous) { $previous } else { New-ResumePlan }; RequestCreated = $false } }

    $windows = Get-Value $State 'windows'
    $roles = Get-Value $State 'windowRoles'
    $shortName = [string](Get-Value $Pause 'pauseWindow')
    if ([string]::IsNullOrWhiteSpace($shortName)) { $shortName = [string](Get-Value $Continuation 'pauseWindow') }
    if ([string]::IsNullOrWhiteSpace($shortName)) { $shortName = [string](Get-Value $roles 'short') }
    $shortWindow = Get-Value $windows $shortName
    if ([string]::IsNullOrWhiteSpace($shortName) -or $null -eq $shortWindow) { return [pscustomobject]@{ Plan = New-ResumePlan -Status 'SKIPPED_INVALID_WINDOW_ROLE'; RequestCreated = $false } }
    $blocking = @($shortName)
    $reset = ConvertTo-Number (Get-Value $Pause 'pauseResetAt')
    if ($null -eq $reset) { $reset = ConvertTo-Number (Get-Value $Continuation 'pauseResetAt') }
    if ($null -eq $reset) { $reset = ConvertTo-Number (Get-Value $shortWindow 'resetsAt') }
    if ($null -eq $reset) { return [pscustomobject]@{ Plan = New-ResumePlan -BlockingWindows $blocking -Status 'SKIPPED_INVALID_RESET'; RequestCreated = $false } }
    $nowUnix = (Get-UtcNow).ToUnixTimeSeconds()
    $blockingResetAt = [long][Math]::Floor($reset)
    $wakeAt = $blockingResetAt + $script:ResumeSafetySeconds
    $waitSeconds = $wakeAt - $nowUnix
    if ($blockingResetAt -le $nowUnix -or $waitSeconds -le 0) { return [pscustomobject]@{ Plan = New-ResumePlan -BlockingWindows $blocking -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -Status 'SKIPPED_INVALID_RESET'; RequestCreated = $false } }
    $previousKey = [string](Get-Value $previous 'scheduleKey')
    $sameWindowAndWake = -not [string]::IsNullOrWhiteSpace($previousKey) -and (ConvertTo-Number (Get-Value $previous 'wakeAt')) -eq $wakeAt -and ((@((Get-Value $previous 'blockingWindows')) -join ',') -eq ($blocking -join ','))
    $cycleId = if ($sameWindowAndWake) { [int](ConvertTo-Number (Get-Value $previous 'cycleId')) } else { [int]([Math]::Max((ConvertTo-Number (Get-Value $previous 'cycleId')), (ConvertTo-Number (Get-Value $Continuation 'cycleId'))) + 1) }
    if ($cycleId -le 0) { $cycleId = 1 }
    $sessionId = ConvertTo-SafeId ([string](Get-Value $Event 'session_id'))
    $scheduleKey = if ($sameWindowAndWake) { $previousKey } else { "${sessionId}:$($blocking -join '+'):${wakeAt}:c$cycleId" }
    $resumeMode = if ($weekly -eq 'FINALIZE') { 'finalize_only' } elseif (Get-Value $Continuation 'resumeMode') { [string](Get-Value $Continuation 'resumeMode') } else { 'continue' }
    if ($waitSeconds -gt $script:ResumeMaxWaitSeconds) { return [pscustomobject]@{ Plan = New-ResumePlan -BlockingWindows $blocking -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -ScheduleKey $scheduleKey -CycleId $cycleId -ResumeMode $resumeMode -Status 'SKIPPED_LONG_WAIT'; RequestCreated = $false } }
    $previousStatus = [string](Get-Value $previous 'status')
    if ($sameWindowAndWake -and $previousStatus -in @('REQUESTED', 'SCHEDULED', 'FAILED')) {
        return [pscustomobject]@{ Plan = New-ResumePlan -Eligible $true -BlockingWindows $blocking -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -ScheduleKey $scheduleKey -CycleId $cycleId -ResumeMode $resumeMode -Status $previousStatus -AutomationId (Get-Value $previous 'automationId') -LastError (Get-Value $previous 'lastError'); RequestCreated = $false }
    }
    return [pscustomobject]@{ Plan = New-ResumePlan -Eligible $true -BlockingWindows $blocking -BlockingResetAt $blockingResetAt -WakeAt $wakeAt -WaitSeconds $waitSeconds -ScheduleKey $scheduleKey -CycleId $cycleId -ResumeMode $resumeMode -Status 'REQUESTED'; RequestCreated = $true }
}

function Get-ResumeAutomationRrule {
    param($WakeAt)
    $unix = ConvertTo-Number $WakeAt
    if ($null -eq $unix) { return $null }
    try { $local = [DateTimeOffset]::FromUnixTimeSeconds([long]$unix).ToLocalTime() } catch { return $null }
    return "RRULE:FREQ=DAILY;BYHOUR=$($local.Hour.ToString('00'));BYMINUTE=$($local.Minute.ToString('00'));BYSECOND=$($local.Second.ToString('00'));COUNT=1"
}

function Get-ResumeAutomationInput {
    param($Plan)
    $key = [string](Get-Value $Plan 'scheduleKey')
    $rrule = Get-ResumeAutomationRrule (Get-Value $Plan 'wakeAt')
    if ([string]::IsNullOrWhiteSpace($key) -or [string]::IsNullOrWhiteSpace($rrule)) { return $null }
    return [ordered]@{
        mode = 'create'
        kind = 'heartbeat'
        destination = 'thread'
        name = 'Usage Guard resume'
        prompt = "Usage Guard recovery scheduleKey=$key cycleId=$([string](Get-Value $Plan 'cycleId')) resumeMode=$([string](Get-Value $Plan 'resumeMode')). Refresh Usage Guard when this heartbeat runs. Continue from the existing checkpoint only after the short window has reset and the weekly policy permits it; obey the current policy, stay quiet if still blocked, and pause this heartbeat after its recovery run."
        rrule = $rrule
        status = 'ACTIVE'
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
    if ($status -eq 'CONSUMED') { return '' }
    if ($status -eq 'WEEKLY_STOPPED') { return ' Weekly quota is below 5%; no heartbeat will be created. Finish the final handoff and wait for the weekly reset.' }
    if ($status -eq 'WEEKLY_FINALIZE') { return ' Weekly quota is in finalization range; finish the current coherent unit and leave a complete handoff. Do not wait on a short-window heartbeat.' }
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
        $input = Get-ResumeAutomationInput $plan
        $json = $input | ConvertTo-Json -Depth 10 -Compress
        return " AUTO-RESUME ACTION: call $script:AutomationToolName exactly once with this direct create input (do not use suggested_create and do not include DTSTART): $json. If the tool is unavailable, report that once and stop after checkpointing."
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
        $State.previousAction = Get-Value $State 'policyAction'
        $State.currentPolicy = 'UNKNOWN'
        $State.shortPolicy = 'UNKNOWN'
        $State.weeklyPolicy = 'UNKNOWN'
        $State.policyAction = 'UNKNOWN'
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
    $action = [string](Get-Value $State 'policyAction')
    $short = Get-Value $evidence 'shortRemaining'
    $weekly = Get-Value $evidence 'weeklyRemaining'
    $suffix = if ($null -ne $effective) { " remaining=$effective%" } else { '' }
    if ($null -ne $short -and $null -ne $weekly) { $suffix += " short=$short% weekly=$weekly%" }
    $shortPolicy = [string](Get-Value $State 'shortPolicy')
    $weeklyPolicy = [string](Get-Value $State 'weeklyPolicy')
    if ($shortPolicy -and $weeklyPolicy -and $shortPolicy -ne 'UNKNOWN' -and $weeklyPolicy -ne 'UNKNOWN') { $suffix += " shortPolicy=$shortPolicy weeklyPolicy=$weeklyPolicy" }
    if ($action -and $action -ne 'UNKNOWN') { $suffix += " action=$action" }
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
    if ($name -eq 'Bash' -or $lowerName -in @('exec_command', 'exec', 'functions.exec')) {
        $statusPattern = if ($lowerName -in @('exec', 'functions.exec')) { '(?i)\bgit\s+(status|diff)(\s|$)' } else { '(?i)^\s*git\s+(status|diff)(\s|$)' }
        if ($command -match $statusPattern) { return [pscustomobject]@{ Cost = 'LOW'; CheckpointSafe = $true; Kind = 'status' } }
        if ($lowerName -in @('exec', 'functions.exec') -and
            $command -match '(?i)(?:apply_patch|tools\.apply_patch)' -and
            $command -match '(?i)(docs[\\/]plan|task_plan\.md|progress\.md|findings\.md|checkpoint|state\.md)') {
            return [pscustomobject]@{ Cost = 'MEDIUM'; CheckpointSafe = $true; Kind = 'edit' }
        }
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
        policyAction = 'UNKNOWN'
        overrideOnce = Test-OverridePrompt ([string](Get-Value $Event 'prompt'))
        stopContinuationRequested = $false
        resumeScheduleAttempted = $false
        resumeContinuationRequested = $false
        resumeScheduleKey = $null
        pauseCandidate = $false
        pauseReason = $null
        pausePolicy = $null
        pauseCandidateAt = $null
        checkpointObserved = $false
        checkpointPath = $null
        checkpointRevision = $null
        checkpointRequestIssued = $false
        pauseWindow = $null
        pauseResetAt = $null
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

function Get-CheckpointMarker {
    param($Event)
    $root = if (-not [string]::IsNullOrWhiteSpace([string](Get-Value $Event 'cwd'))) { [System.IO.Path]::GetFullPath([string](Get-Value $Event 'cwd')) } else { (Get-Location).Path }
    $markerPath = [System.IO.Path]::Combine($root, $script:CheckpointRelativePath)
    if (-not [System.IO.File]::Exists($markerPath)) { return $null }
    try { $marker = (Read-JsonFile $markerPath) } catch { return $null }
    if ($null -eq $marker -or [string](Get-Value $marker 'sessionId') -ne [string](Get-Value $Event 'session_id')) { return $null }
    $status = [string](Get-Value $marker 'taskStatus')
    if ($status -notin @('RUNNING', 'PAUSED_QUOTA', 'COMPLETED', 'CANCELLED', 'WAITING_USER', 'WEEKLY_STOPPED')) { return $null }
    $checkpointPath = [string](Get-Value $marker 'checkpointPath')
    $planRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, 'docs', 'plan'))
    $resolved = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $checkpointPath))
    $relative = [System.IO.Path]::GetRelativePath($planRoot, $resolved)
    if ([string]::IsNullOrWhiteSpace($checkpointPath) -or $relative.StartsWith('..') -or [System.IO.Path]::IsPathRooted($relative) -or -not [System.IO.File]::Exists($resolved)) { return $null }
    $revision = [string](Get-Value $marker 'revision')
    if ([string]::IsNullOrWhiteSpace($revision)) { $revision = [string](Get-Value $marker 'checkpointRevision') }
    if ([string]::IsNullOrWhiteSpace($revision)) { return $null }
    if ($status -eq 'PAUSED_QUOTA' -and ([string](Get-Value $marker 'pauseReason') -notin @('short_window', 'weekly_budget', 'plugin_pause') -or [string]::IsNullOrWhiteSpace([string](Get-Value $marker 'nextStep')))) { return $null }
    return [pscustomobject]@{ Marker = $marker; CheckpointPath = $checkpointPath; Revision = $revision }
}

function Invoke-CheckpointPostTool {
    param($Event)
    if ((Get-Value (Get-Value $Event 'tool_response') 'isError') -eq $true) { return @{} }
    $verified = Get-CheckpointMarker $Event
    if ($null -eq $verified) { return @{} }
    $turn = Get-TurnRecord $Event
    if ($null -eq $turn) { $turn = New-TurnRecord $Event }
    $marker = $verified.Marker
    $status = [string](Get-Value $marker 'taskStatus')
    $turn.checkpointObserved = $true
    $turn.checkpointRequestIssued = $true
    $turn.checkpointPath = $verified.CheckpointPath
    $turn.checkpointRevision = $verified.Revision
    if ($status -eq 'PAUSED_QUOTA') {
        $turn.pauseCandidate = $true
        $turn.pauseReason = 'usage_guard'
        $turn.pauseWindow = [string](Get-Value $marker 'pauseWindow')
        if ([string]::IsNullOrWhiteSpace($turn.pauseWindow)) { $turn.pauseWindow = if ([string](Get-Value $marker 'pauseReason') -eq 'weekly_budget') { [string](Get-Value (Get-Value (Get-State) 'windowRoles') 'weekly') } else { [string](Get-Value (Get-Value (Get-State) 'windowRoles') 'short') } }
        $turn.pauseResetAt = ConvertTo-Number (Get-Value $marker 'pauseResetAt')
    }
    Save-TurnRecord $Event $turn
    return New-ContextOutput 'PostToolUse' 'Usage Guard checkpoint registered; continuation state is durable.'
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
        $classification = Get-ToolClassification $Event
        $pause = if ($Turn.pauseCandidate -and $Turn.checkpointObserved) { $Turn } else { $null }
        $resume = if ($null -ne $pause -or $classification.Kind -eq 'resume-automation') { Get-ResumePlanForState $state $Event $previousPlan $pause } else { [pscustomobject]@{ Plan = $previousPlan; RequestCreated = $false } }
        $state.resumePlan = $resume.Plan
        $Turn.usageChecked = $true
        $Turn.effectivePolicy = $state.currentPolicy
        $Turn.policyAction = $state.policyAction
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $Turn
        return [pscustomobject]@{ Succeeded = $true; State = $state; Turn = $Turn; Error = $null; ResumeRequestCreated = $resume.RequestCreated }
    }
    catch {
        [Console]::Error.WriteLine("[usage-guard] quota query failed: $($_.Exception.Message)")
        $state = Register-UsageFailure $state
        $Turn.usageChecked = $false
        $Turn.effectivePolicy = $state.currentPolicy
        $Turn.policyAction = $state.policyAction
        Write-JsonAtomic (Get-StatePath) $state
        Save-TurnRecord $Event $Turn
        return [pscustomobject]@{ Succeeded = $false; State = $state; Turn = $Turn; Error = $_.Exception.Message; ResumeRequestCreated = $false }
    }
}

function Update-PauseCandidate {
    param($Turn, $State, $Classification, [string]$Policy, $Continuation = $null)
    if ($null -eq $Turn -or $Classification.Kind -eq 'resume-automation') { return $false }
    if ([string](Get-Value $Continuation 'taskStatus') -in @('PAUSED_QUOTA', 'COMPLETED', 'CANCELLED', 'WAITING_USER', 'WEEKLY_STOPPED')) { return $false }
    $action = [string](Get-Value $State 'policyAction')
    if ([string]::IsNullOrWhiteSpace($action)) { $action = @{ EMERGENCY = 'SHORT_SUSPEND'; CRITICAL = 'SHORT_CRITICAL' }[$Policy] }
    if ($action -notin @('SHORT_CRITICAL', 'SHORT_SUSPEND', 'WEEKLY_FINALIZE', 'WEEKLY_STOP')) { return $false }
    if ([bool]$Turn.pauseCandidate) { return $false }
    $windows = Get-Value $State 'windows'
    $roles = Get-Value $State 'windowRoles'
    $role = if ($action.StartsWith('WEEKLY')) { 'weekly' } else { 'short' }
    $candidateWindow = [string](Get-Value $roles $role)
    $candidate = Get-Value $windows $candidateWindow
    $Turn.pauseCandidate = $true
    $Turn.pauseReason = 'usage_guard'
    $Turn.pausePolicy = $Policy
    $Turn.pauseCandidateAt = (Get-UtcNow).ToString('o')
    $Turn.pauseWindow = if ($candidateWindow) { $candidateWindow } else { $null }
    $Turn.pauseResetAt = ConvertTo-Number (Get-Value $candidate 'resetsAt')
    $Turn.checkpointObserved = $false
    return $true
}

function Get-CheckpointHint {
    param($Event, $State, $Continuation = $null)
    $action = [string](Get-Value $State 'policyAction')
    if ($action -notin @('SHORT_CRITICAL', 'SHORT_SUSPEND', 'WEEKLY_FINALIZE', 'WEEKLY_STOP')) { return '' }
    if ([string](Get-Value $Continuation 'taskStatus') -eq 'PAUSED_QUOTA') { return '' }
    $reason = if ($action.StartsWith('WEEKLY')) { 'weekly_budget' } else { 'short_window' }
    $weekly = [string](Get-Value $State 'weeklyPolicy')
    $mode = if ($action.StartsWith('WEEKLY') -or $weekly -eq 'FINALIZE') { 'finalize_only' } else { 'continue' }
    $sessionId = [string](Get-Value $Event 'session_id')
    $pathText = $script:CheckpointRelativePath -replace '\\', '/'
    return " If this turn must pause, write $pathText with JSON containing sessionId '$sessionId', taskStatus 'PAUSED_QUOTA', pauseReason '$reason', checkpointPath 'docs/plan/progress.md', revision '<new non-empty revision>', resumeMode '$mode', and nextStep '<one bounded next step>'; let the post-tool hook register it before stopping."
}

function Test-MatchingResumeAutomation {
    param($Event, $State, $Plan = $null)
    $plan = if ($null -ne $Plan) { $Plan } else { Get-Value $State 'resumePlan' }
    if (-not [bool](Get-Value $plan 'eligible')) { return $false }
    $expected = Get-ResumeAutomationInput $plan
    $input = Get-Value $Event 'tool_input'
    if ($null -eq $expected -or $null -eq $input) { return $false }
    $prompt = Get-Value $input 'prompt'
    return (Get-Value $input 'mode') -eq $expected.mode -and
        (Get-Value $input 'kind') -eq $expected.kind -and
        (Get-Value $input 'destination') -eq $expected.destination -and
        (Get-Value $input 'name') -eq $expected.name -and
        (Get-Value $input 'rrule') -eq $expected.rrule -and
        (Get-Value $input 'status') -eq $expected.status -and
        $prompt -is [string] -and
        $prompt.Contains([string](Get-Value $plan 'scheduleKey'), [StringComparison]::Ordinal) -and
        $prompt -match '(?i)usage[ -]guard'
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
    if ($null -eq $turn) { $turn = New-TurnRecord $Event }
    $override = [bool](Get-Value $turn 'overrideOnce')
    $refresh = Update-UsageSnapshot $Event $turn
    $turn = $refresh.Turn
    $state = $refresh.State
    $policy = [string](Get-Value $state 'currentPolicy')
    if ([string]::IsNullOrWhiteSpace($policy)) { $policy = 'UNKNOWN' }
    $action = [string](Get-Value $state 'policyAction')
    if ([string]::IsNullOrWhiteSpace($action)) { $action = 'UNKNOWN' }
    if ($override) {
        return New-ContextOutput 'PreToolUse' "Usage Guard one-turn override is active. Continue deliberately; usage warnings still apply. $((Get-PolicySummary $state))"
    }
    if (Update-PauseCandidate $turn $state $classification $policy) { Save-TurnRecord $Event $turn }
    if ($classification.Kind -eq 'resume-automation') {
        $plan = Get-Value $state 'resumePlan'
        $planned = Test-ActiveResumePlan $plan
        if ($action -eq 'WEEKLY_STOP') { return New-DenyOutput 'Usage Guard weekly quota stop disables recovery heartbeats.' }
        if ($action -ne 'SHORT_SUSPEND' -and -not $planned) { return @{} }
        if (-not (Test-MatchingResumeAutomation $Event $state $plan)) {
            return New-DenyOutput 'Usage Guard permits only the heartbeat matching the current recovery schedule key.'
        }
        $turn.resumeScheduleAttempted = $true
        $turn.resumeScheduleKey = Get-Value $plan 'scheduleKey'
        Save-TurnRecord $Event $turn
        return New-ContextOutput 'PreToolUse' 'Usage Guard permits this matching bounded auto-resume heartbeat operation.'
    }
    if ($policy -eq 'UNKNOWN' -or $action -in @('UNKNOWN', 'UNKNOWN_WINDOW_ROLE')) {
        return New-ContextOutput 'PreToolUse' 'Usage state is UNKNOWN; fail-open is active. Continue cautiously and preserve a checkpoint after repeated failures.' 'Usage Guard could not read quota and is failing open.'
    }
    if ($action -eq 'RUN' -or $policy -eq 'NORMAL') { return @{} }
    switch ($action) {
        'SHORT_CONSERVE' {
            if ($classification.Kind -eq 'expansion') { return New-DenyOutput 'Usage Guard CONSERVE blocks new subagents and generated-media expansion.' }
            return New-ContextOutput 'PreToolUse' "Usage Guard CONSERVE: $((Get-PolicySummary $state)). Keep scope narrow."
        }
        'WEEKLY_LOW' {
            if ($classification.Kind -eq 'expansion') { return New-DenyOutput 'Usage Guard WEEKLY_LOW blocks new scope and expansion.' }
            return New-ContextOutput 'PreToolUse' "Usage Guard WEEKLY_LOW: finish the current coherent unit and prepare a complete handoff. $((Get-PolicySummary $state))"
        }
        'WEEKLY_STOP' {
            if (-not $classification.CheckpointSafe) { return New-DenyOutput "Usage Guard WEEKLY_STOP allows only a final bounded checkpoint: $((Get-PolicySummary $state))." }
            return New-ContextOutput 'PreToolUse' "Usage Guard WEEKLY_STOP: write the complete handoff and stop; $((Get-PolicySummary $state)).$(Get-CheckpointHint $Event $state $null)"
        }
        'WEEKLY_FINALIZE' {
            if ($classification.Cost -eq 'HIGH' -or $classification.Kind -eq 'expansion') { return New-DenyOutput "Usage Guard WEEKLY_FINALIZE blocks expansion: $((Get-PolicySummary $state))." }
            return New-ContextOutput 'PreToolUse' "Usage Guard WEEKLY_FINALIZE: finish only the current coherent unit and write a complete handoff; $((Get-PolicySummary $state)).$(Get-CheckpointHint $Event $state $null)"
        }
        'SHORT_CRITICAL' {
            if ($classification.Cost -eq 'HIGH') { return New-DenyOutput "Usage Guard CRITICAL blocks high-cost work: $((Get-PolicySummary $state))." }
            return New-ContextOutput 'PreToolUse' "Usage Guard CRITICAL: finish only the smallest necessary step; $((Get-PolicySummary $state)).$(Get-CheckpointHint $Event $state $null)"
        }
        'SHORT_SUSPEND' {
            if (-not $classification.CheckpointSafe) { return New-DenyOutput "Usage Guard EMERGENCY allows only bounded checkpoint, status, and reporting operations: $((Get-PolicySummary $state))." }
            return New-ContextOutput 'PreToolUse' "Usage Guard EMERGENCY: this bounded checkpoint operation is allowed; do not expand its scope.$(Get-CheckpointHint $Event $state $null)"
        }
        default {
            if ($policy -eq 'CONSERVE') { return New-ContextOutput 'PreToolUse' "Usage Guard CONSERVE: $((Get-PolicySummary $state)). Keep scope narrow." }
            if ($policy -eq 'CRITICAL') { return New-ContextOutput 'PreToolUse' "Usage Guard CRITICAL: finish only the smallest necessary step; $((Get-PolicySummary $state))." }
            if ($policy -eq 'EMERGENCY') { return New-ContextOutput 'PreToolUse' "Usage Guard EMERGENCY: this bounded checkpoint operation is allowed; do not expand its scope." }
            return @{}
        }
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
            return New-ContextOutput 'SessionStart' "Usage Guard is active and queries Codex usage automatically on each user turn and before every tool call. $((Get-PolicySummary $state))."
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
            if ($toolName -eq $script:UsageToolName) { return Invoke-UsagePostTool $Event }
            return Invoke-CheckpointPostTool $Event
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
            if ([string](Get-Value $state 'policyAction') -eq 'WEEKLY_STOP' -and $null -ne $turn -and [bool](Get-Value $turn 'checkpointObserved')) {
                $plan = New-ResumePlan -Status 'WEEKLY_STOPPED' -ResumeMode 'finalize_only'
                $state.resumePlan = $plan
                Write-JsonAtomic (Get-StatePath) $state
                return @{}
            }
            $confirmed = $null -ne $turn -and [bool](Get-Value $turn 'checkpointObserved') -and -not [string]::IsNullOrWhiteSpace([string](Get-Value $turn 'checkpointRevision'))
            if ($null -ne $turn -and [bool](Get-Value $turn 'pauseCandidate') -and -not $confirmed -and -not [bool](Get-Value $turn 'checkpointRequestIssued')) {
                $turn.checkpointRequestIssued = $true
                Save-TurnRecord $Event $turn
                $pathText = $script:CheckpointRelativePath -replace '\\', '/'
                return [ordered]@{ decision = 'block'; reason = "Usage Guard pause requires one verified checkpoint marker at $pathText; write it with the required sessionId/taskStatus/pauseReason/checkpointPath/revision/nextStep fields, then let PostToolUse register it." }
            }
            $requested = [bool](Get-Value $plan 'eligible') -and [string](Get-Value $plan 'status') -eq 'REQUESTED'
            if (-not $requested -and $confirmed) {
                $resume = Get-ResumePlanForState $state $Event $plan $turn
                $state.resumePlan = $resume.Plan
                $plan = $resume.Plan
                $requested = [bool](Get-Value $plan 'eligible') -and [string](Get-Value $plan 'status') -eq 'REQUESTED'
                Write-JsonAtomic (Get-StatePath) $state
            }
            $wakeAtValue = ConvertTo-Number (Get-Value $plan 'wakeAt')
            $nowUnix = (Get-UtcNow).ToUnixTimeSeconds()
            if ($requested -and ($null -eq $wakeAtValue -or $wakeAtValue -le $nowUnix)) {
                $plan.eligible = $false
                $plan.status = 'SKIPPED_INVALID_RESET'
                $plan.lastError = 'Recovery wake time expired before scheduling.'
                $plan.updatedAt = (Get-UtcNow).ToString('o')
                $state.resumePlan = $plan
                Write-JsonAtomic (Get-StatePath) $state
                return @{}
            }
            if ($null -eq $turn) { return @{} }
            $attempted = [bool](Get-Value $turn 'resumeScheduleAttempted')
            $continued = [bool](Get-Value $turn 'resumeContinuationRequested')
            if ($requested -and -not $attempted -and -not $continued) {
                $turn.resumeContinuationRequested = $true
                Save-TurnRecord $Event $turn
                $wakeAt = [long]$wakeAtValue
                $wakeIso = [DateTimeOffset]::FromUnixTimeSeconds($wakeAt).ToString('o')
                $key = [string](Get-Value $plan 'scheduleKey')
                $input = Get-ResumeAutomationInput $plan
                $json = $input | ConvertTo-Json -Depth 10 -Compress
                return [ordered]@{ decision = 'block'; reason = "Attempt the one Usage Guard same-thread heartbeat now with $script:AutomationToolName using this direct create input (do not use suggested_create and do not include DTSTART): $json for wakeAt=$wakeIso scheduleKey=$key. If the tool is unavailable, report that once, preserve the checkpoint, and stop; do not retry." }
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
