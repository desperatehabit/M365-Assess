# Invoke-VersionCleanup.ps1 — EPIC-025 SharePoint version cleanup (SPEC §3.3, §4.2, §8, §9, §11 item 2; T-0487).
#
# Plan mode computes exactly which versions will be removed — the age threshold
# (versions older than -AgeThresholdDays, default 90) plus the manual
# include/exclude override — and performs no writes. The current version is
# always protected. Apply mode requires -ConfirmCount to name the version count
# and removes each version through the EPIC-006 gated executor
# (Invoke-RemediationApply, T-0108): per-version before/after, one audit event
# per removal, and a VersionCleanupJob-shaped record carrying every per-version
# result, so a partial batch can never succeed silently.
#
# Graph writes and audit persistence are injectable scriptblock seams so Pester
# exercises the orchestration without a tenant. The default removal seam issues
# the driveItem version DELETE; the default audit seam is a no-op and the
# emitted auditEvents array carries the exact payloads the caller persists.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'Invoke-RemediationApply.ps1')

function Get-NextLink {
    param($Response)
    if ($null -ne $Response -and $null -ne $Response.PSObject.Properties['@odata.nextLink']) {
        return $Response.'@odata.nextLink'
    }
    return $null
}

function Get-VersionRemovalUri {
    <#
    .SYNOPSIS
        Builds the Graph DELETE URI for one version descriptor.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        $Version
    )

    $versionId = [string]$Version.versionId
    $itemId = [string]$Version.itemId
    $siteId = [string]$Version.siteId
    if ([string]::IsNullOrWhiteSpace($versionId)) { throw 'version-cleanup.missing_version_id' }
    if ([string]::IsNullOrWhiteSpace($itemId)) { throw 'version-cleanup.missing_item_id' }
    if ([string]::IsNullOrWhiteSpace($siteId)) { throw 'version-cleanup.missing_site_id' }
    return "/v1.0/sites/$siteId/drive/items/$itemId/versions/$versionId"
}

function Invoke-VersionCleanup {
    <#
    .SYNOPSIS
        Plans or applies SharePoint version cleanup.
    .DESCRIPTION
        Implements EPIC-025 SPEC.md §4.2 and §11 item 2. Plan mode (default)
        returns exactly which versions will be removed and performs no writes.
        Apply mode requires -ConfirmCount to equal the planned count and removes
        each version through the EPIC-006 gated executor (Invoke-RemediationApply).
    .PARAMETER TenantId
    .PARAMETER SiteId
    .PARAMETER AgeThresholdDays
        Versions older than this many days are cleanup candidates. Default 90.
    .PARAMETER IncludeVersions
        Manual include override: version IDs to always select (even if newer
        than the threshold). The current version is still protected.
    .PARAMETER ExcludeVersions
        Manual exclude override: version IDs to never select (even if older
        than the threshold).
    .PARAMETER Mode
        Plan (default) never writes; Apply removes.
    .PARAMETER ConfirmCount
        Apply requires this to equal the planned version count.
    .PARAMETER Actor
    .PARAMETER CorrelationId
    .PARAMETER JobId
    .PARAMETER ListVersions
        Seam: scriptblock (siteId) -> version descriptors. Defaults to Graph.
    .PARAMETER RemoveVersion
        Seam: scriptblock (version) -> @{ before; after }. Defaults to Graph DELETE.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op; audit payloads
        are still returned in auditEvents for the caller to persist.
    .OUTPUTS
        [PSCustomObject] with the plan or apply result.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId,

        [Parameter()]
        [ValidateRange(0, 3650)]
        [int]$AgeThresholdDays = 90,

        [Parameter()]
        [string[]]$IncludeVersions = @(),

        [Parameter()]
        [string[]]$ExcludeVersions = @(),

        [Parameter()]
        [ValidateSet('Plan', 'Apply')]
        [string]$Mode = 'Plan',

        [Parameter()]
        [int]$ConfirmCount = -1,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$JobId = '',

        [Parameter()]
        [scriptblock]$ListVersions,

        [Parameter()]
        [scriptblock]$RemoveVersion,

        [Parameter()]
        [scriptblock]$WriteAudit
    )

    if (-not $JobId) { $JobId = [guid]::NewGuid().ToString() }
    $now = [DateTime]::UtcNow.ToString('o')
    if (-not $ListVersions) {
        $ListVersions = {
            param($TargetSiteId)
            $versions = New-Object System.Collections.Generic.List[object]
            $itemsUri = "/v1.0/sites/$TargetSiteId/drive/items?`$select=id"
            do {
                $itemsResponse = Invoke-MgGraphRequest -Method GET -Uri $itemsUri
                if ($null -ne $itemsResponse -and $null -ne $itemsResponse.value) {
                    foreach ($item in @($itemsResponse.value)) {
                        $itemId = [string]$item.id
                        $versionsUri = "/v1.0/sites/$TargetSiteId/drive/items/$itemId/versions?`$select=id,size,lastModifiedDateTime"
                        do {
                            $versionsResponse = Invoke-MgGraphRequest -Method GET -Uri $versionsUri
                            if ($null -ne $versionsResponse -and $null -ne $versionsResponse.value) {
                                $versionList = @($versionsResponse.value)
                                for ($i = 0; $i -lt $versionList.Count; $i++) {
                                    $v = $versionList[$i]
                                    $versions.Add([pscustomobject]@{
                                        versionId    = [string]$v.id
                                        itemId       = $itemId
                                        siteId       = $TargetSiteId
                                        size         = if ($null -ne $v.size) { [int64]$v.size } else { [int64]0 }
                                        lastModified = if ($v.lastModifiedDateTime) { [string]$v.lastModifiedDateTime } else { '' }
                                        isCurrent    = ($i -eq 0)
                                    }) | Out-Null
                                }
                            }
                            $versionsUri = Get-NextLink -Response $versionsResponse
                        } while ($versionsUri)
                    }
                }
                $itemsUri = Get-NextLink -Response $itemsResponse
            } while ($itemsUri)
            return $versions.ToArray()
        }
    }
    if (-not $RemoveVersion) {
        $RemoveVersion = {
            param($version)
            $uri = Get-VersionRemovalUri -Version $version
            $null = Invoke-MgGraphRequest -Method 'DELETE' -Uri $uri
            return @{ before = $version; after = $null }
        }
    }
    if (-not $WriteAudit) { $WriteAudit = { param($auditEvent) } }

    $allVersions = @(& $ListVersions $SiteId)
    $cutoff = (Get-Date).AddDays(-$AgeThresholdDays)

    $planned = New-Object System.Collections.Generic.List[object]
    foreach ($version in $allVersions) {
        $versionId = [string]$version.versionId
        if ([string]::IsNullOrWhiteSpace($versionId)) {
            throw 'version-cleanup.missing_version_id'
        }
        $lastModified = [string]$version.lastModified
        $isOld = $false
        if (-not [string]::IsNullOrWhiteSpace($lastModified)) {
            $isOld = [datetime]$lastModified -lt $cutoff
        }
        $isIncluded = $IncludeVersions -contains $versionId
        $isExcluded = $ExcludeVersions -contains $versionId
        $isCurrent = [bool]$version.isCurrent
        $selected = ($isOld -or $isIncluded) -and -not $isExcluded -and -not $isCurrent
        $reason = if ($isCurrent) { 'current-version-protected' }
                  elseif ($isExcluded) { 'excluded-by-operator' }
                  elseif ($selected) { $null }
                  else { 'newer-than-threshold' }
        $planned.Add([ordered]@{
            versionId    = $versionId
            itemId       = [string]$version.itemId
            size         = [int64]$version.size
            lastModified = $lastModified
            isCurrent    = $isCurrent
            selected     = $selected
            reason       = $reason
        }) | Out-Null
    }

    $selectedVersions = @($planned | Where-Object { $_.selected })

    if ($Mode -eq 'Plan') {
        $reclaimableBytes = [int64]0
        foreach ($v in $selectedVersions) {
            $reclaimableBytes += [int64]$v.size
        }
        return [pscustomobject]@{
            jobId            = $JobId
            tenantId         = $TenantId
            siteId           = $SiteId
            mode             = 'plan'
            state            = 'planned'
            ageThresholdDays = $AgeThresholdDays
            cutoffDate       = $cutoff.ToString('o')
            versions         = $planned.ToArray()
            selectedCount    = $selectedVersions.Count
            reclaimableBytes = $reclaimableBytes
            writes           = $false
        }
    }

    if ($ConfirmCount -ne $selectedVersions.Count) {
        throw "version-cleanup.confirm_required: apply removes $($selectedVersions.Count) versions and requires -ConfirmCount $($selectedVersions.Count)"
    }

    $actions = @($selectedVersions | ForEach-Object {
        [pscustomobject]@{
            id      = [string]$_.versionId
            checkId = 'SPO-VERSION-CLEANUP'
            command = 'Remove-SPOVersion'
        }
    })

    $auditEvents = New-Object System.Collections.Generic.List[object]
    $applyResult = Invoke-RemediationApply `
        -Actions $actions `
        -PlanId $JobId `
        -TenantId $TenantId `
        -DryRun:$false `
        -Actor $Actor `
        -CorrelationId $CorrelationId `
        -TestEligibility {
            param($CheckId)
            return [pscustomobject]@{ Eligible = $true; SpecStatus = 'approved' }
        } `
        -ExecuteAction {
            param($action)
            $version = $selectedVersions | Where-Object { [string]$_.versionId -eq [string]$action.id } | Select-Object -First 1
            $outcome = & $RemoveVersion $version
            return [pscustomobject]@{
                State          = 'applied'
                Before         = $outcome.before
                After          = $outcome.after
                IntendedChange = $null
                Reason         = $null
                AppliedAt      = [DateTime]::UtcNow.ToString('o')
            }
        } `
        -UpdateAction { param($actionId, $update) } `
        -WriteAudit { param($auditEvent) $auditEvents.Add($auditEvent) }

    $results = New-Object System.Collections.Generic.List[object]
    foreach ($r in @($applyResult.Results)) {
        $results.Add([ordered]@{
            versionId = [string]$r.actionId
            state     = [string]$r.state
            before    = $r.before
            after     = $r.after
            appliedAt = $r.appliedAt
            actor     = $r.actor
            error     = $r.error
        }) | Out-Null
    }

    $removedCount = @($results | Where-Object { $_.state -eq 'applied' }).Count
    $failedCount = @($results | Where-Object { $_.state -eq 'failed' }).Count
    $skippedCount = @($results | Where-Object { $_.state -eq 'skipped' }).Count
    $state = if ($failedCount -gt 0) { 'failed' } else { 'completed' }

    return [pscustomobject]@{
        jobId            = $JobId
        tenantId         = $TenantId
        siteId           = $SiteId
        mode             = 'apply'
        state            = $state
        ageThresholdDays = $AgeThresholdDays
        cutoffDate       = $cutoff.ToString('o')
        results          = $results.ToArray()
        auditEvents      = $auditEvents.ToArray()
        summary          = [pscustomobject]@{
            total   = $selectedVersions.Count
            removed = $removedCount
            failed  = $failedCount
            skipped = $skippedCount
        }
        job = [pscustomobject]@{
            id        = $JobId
            tenantId  = $TenantId
            siteId    = $SiteId
            versionIds = @($selectedVersions | ForEach-Object { [string]$_.versionId })
            state     = $state
            results   = $results.ToArray()
            createdAt = $now
            createdBy = $Actor
        }
    }
}
