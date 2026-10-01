# Invoke-SecureScoreSnapshot.ps1 — EPIC-031 Secure Score daily snapshot job
# (SPEC.md §4.2, §5, §11.2; T-0604).
#
# A daily cadence (§11.2), not per run: the EPIC-007 system timer (T-0123)
# invokes this handler once per tenant. It captures the current score through the
# T-0602 read path (Get-SecureScore) and hands the snapshot to the T-0601 store.
# Recording is idempotent within a UTC day — a tenant that already has a snapshot
# for the day is skipped — and retention is enforced through the T-0601 prune
# seam so the trend window obeys the configured retention. The job performs no
# tenant writes: the T-0602 read is GET-only and the only write is a portal-local
# snapshot.

# Strict mode is deliberately not enabled here: the T-0602 read path is
# dot-sourced below and reads optional Graph fields (e.g. '@odata.nextLink') that
# are absent on the final page, which strict mode would turn into an error.
$ErrorActionPreference = 'Stop'

# The T-0602 read path lives beside this handler; dot-source it when present so a
# direct invocation reads Graph, while tests inject -ReadScore.
$script:SecureScoreReadPath = Join-Path -Path $PSScriptRoot -ChildPath 'Get-SecureScore.ps1'
if (Test-Path -LiteralPath $script:SecureScoreReadPath -PathType Leaf) {
    . $script:SecureScoreReadPath
}

# Retention window (days) applied to snapshots when no explicit -RetentionDays is
# given. Matches the trend API default (secure-score-trend.ts).
$script:SecureScoreSnapshotRetentionDays = 90

function Get-SecureScoreSnapshotProperty {
    param(
        [Parameter()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function ConvertTo-SecureScoreSnapshotCategories {
    <#
    .SYNOPSIS
        Converts the T-0602 category split to the T-0601 categories JSON object.
    .DESCRIPTION
        The T-0601 repository stores `categories` as a JSON object; key it by
        category name so the trend read can look a category up without scanning.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.IDictionary])]
    param([Parameter()][AllowNull()][object]$Categories)

    $map = [ordered]@{}
    foreach ($entry in @($Categories)) {
        if ($null -eq $entry) { continue }
        $name = [string](Get-SecureScoreSnapshotProperty -Object $entry -Name 'category')
        if (-not $name) { continue }
        $map[$name] = [ordered]@{
            achieved   = [double](Get-SecureScoreSnapshotProperty -Object $entry -Name 'achieved')
            available  = [double](Get-SecureScoreSnapshotProperty -Object $entry -Name 'available')
            percentage = [double](Get-SecureScoreSnapshotProperty -Object $entry -Name 'percentage')
        }
    }
    return $map
}

function Test-SecureScoreSnapshotRecordedForDay {
    <#
    .SYNOPSIS
        True when any snapshot was observed within [DayStart, DayStart + 1 day).
    .DESCRIPTION
        The daily idempotency guard: a snapshot recorded at any time inside the
        UTC day means the tenant is already captured for that day.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()][AllowNull()][object[]]$Snapshots,
        [Parameter(Mandatory)][datetime]$DayStart
    )

    $dayEnd = $DayStart.AddDays(1)
    foreach ($snapshot in @($Snapshots)) {
        if ($null -eq $snapshot) { continue }
        $at = [string](Get-SecureScoreSnapshotProperty -Object $snapshot -Name 'at')
        if (-not $at) { continue }
        try { $observed = [datetimeoffset]::Parse($at).UtcDateTime }
        catch { continue }
        if ($observed -ge $DayStart -and $observed -lt $dayEnd) { return $true }
    }
    return $false
}

function Invoke-SecureScoreSnapshot {
    <#
    .SYNOPSIS
        Records at most one Secure Score snapshot per tenant per UTC day.
    .DESCRIPTION
        Implements EPIC-031 SPEC.md §4.2 with the daily cadence fixed by §11.2.
        Reads the current score through the T-0602 read path, skips the write when
        the tenant already has a snapshot for the day, and prunes snapshots older
        than the T-0601 retention window. No tenant write is performed.
    .PARAMETER TenantId
        Tenant to snapshot.
    .PARAMETER RetentionDays
        T-0601 retention window in days; 0 or less disables pruning.
    .PARAMETER Now
        ISO-8601 observation instant; defaults to now (UTC).
    .PARAMETER ReadScore
        Seam: scriptblock (tenantId) -> score. Defaults to the T-0602 Get-SecureScore.
    .PARAMETER ListSnapshots
        Seam: scriptblock (tenantId, from, to) -> snapshots (T-0601).
    .PARAMETER RecordSnapshot
        Seam: scriptblock (snapshot) -> persisted snapshot (T-0601).
    .PARAMETER PruneSnapshots
        Seam: scriptblock (retentionDays) -> prune result with prunedSnapshotsCount.
    .OUTPUTS
        [PSCustomObject] with TenantId, DayStart, Recorded, Reason, Snapshot,
        PrunedCount, RetentionDays.
    .EXAMPLE
        Invoke-SecureScoreSnapshot -TenantId 'contoso' -RecordSnapshot $record
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [int]$RetentionDays = $script:SecureScoreSnapshotRetentionDays,

        [Parameter()]
        [string]$Now = '',

        [Parameter()]
        [scriptblock]$ReadScore,

        [Parameter()]
        [scriptblock]$ListSnapshots,

        [Parameter()]
        [scriptblock]$RecordSnapshot,

        [Parameter()]
        [scriptblock]$PruneSnapshots
    )

    if (-not $Now) { $Now = [DateTime]::UtcNow.ToString('o') }
    $instant = [datetimeoffset]::Parse($Now).UtcDateTime
    $observedAt = $instant.ToString('o')
    $dayStart = [datetime]::new(
        $instant.Year, $instant.Month, $instant.Day, 0, 0, 0, [System.DateTimeKind]::Utc
    )
    $dayEnd = $dayStart.AddDays(1)

    if (-not $ReadScore) {
        $ReadScore = {
            param($tenantId)
            $command = Get-Command -Name 'Get-SecureScore' -CommandType Function -ErrorAction SilentlyContinue
            if ($null -eq $command) {
                throw 'Get-SecureScore (T-0602 read path) is not available; supply -ReadScore'
            }
            return Get-SecureScore -TenantId $tenantId
        }
    }
    if (-not $ListSnapshots) { $ListSnapshots = { param($tenantId, $from, $to) @() } }
    if (-not $RecordSnapshot) { $RecordSnapshot = { param($snapshot) $null } }
    if (-not $PruneSnapshots) { $PruneSnapshots = { param($retentionDays) $null } }

    $recorded = $false
    $reason = 'already-recorded'
    $snapshot = $null

    # Daily idempotency: any snapshot already observed today is enough.
    $existing = @(& $ListSnapshots $TenantId $dayStart.ToString('o') $dayEnd.ToString('o'))
    if (-not (Test-SecureScoreSnapshotRecordedForDay -Snapshots $existing -DayStart $dayStart)) {
        $score = & $ReadScore $TenantId
        if ($null -eq $score) { throw 'Secure Score read returned no result' }
        $payload = [ordered]@{
            tenantId   = $TenantId
            at         = $observedAt
            current    = [double](Get-SecureScoreSnapshotProperty -Object $score -Name 'current')
            max        = [double](Get-SecureScoreSnapshotProperty -Object $score -Name 'max')
            percentage = [double](Get-SecureScoreSnapshotProperty -Object $score -Name 'percentage')
            categories = ConvertTo-SecureScoreSnapshotCategories -Categories (
                Get-SecureScoreSnapshotProperty -Object $score -Name 'categories'
            )
        }
        $snapshot = & $RecordSnapshot $payload
        $recorded = $true
        $reason = 'recorded'
    }

    # Retention runs every day, recorded or not: pruning is independent of capture.
    $prunedCount = 0
    if ($RetentionDays -gt 0) {
        $pruneResult = & $PruneSnapshots $RetentionDays
        if ($null -ne $pruneResult) {
            $prunedCount = [int](Get-SecureScoreSnapshotProperty -Object $pruneResult -Name 'prunedSnapshotsCount')
        }
    }

    return [PSCustomObject]@{
        TenantId      = $TenantId
        DayStart      = $dayStart.ToString('o')
        Recorded      = $recorded
        Reason        = $reason
        Snapshot      = $snapshot
        PrunedCount   = $prunedCount
        RetentionDays = $RetentionDays
    }
}
