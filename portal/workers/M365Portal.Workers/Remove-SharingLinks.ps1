# Remove-SharingLinks.ps1 — EPIC-027 bulk sharing-link removal (SPEC §3.4, §4.2, §8; T-0527).
#
# Plan mode returns exactly which links will be removed and performs no writes.
# Apply mode requires -ConfirmCount to name the link count and removes each link
# through the EPIC-006 gated-executor contract (T-0108): per-link before/after,
# one audit event per removal, and a LinkRemovalJob-shaped record carrying every
# per-link result, so a partial batch can never succeed silently. v1 removes
# sharing links (anonymous and organization) only; direct-permission removal is
# deferred (SPEC §11 item 3) and such entries are recorded as skipped, not dropped.
#
# Graph writes and audit persistence are injectable scriptblock seams so Pester
# exercises the orchestration without a tenant. The default removal seam issues
# the driveItem permission DELETE; the default audit seam is a no-op and the
# emitted auditEvents array carries the exact payloads the caller persists.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RemovableLinkTypes = @('anonymous', 'organization')

function Get-SharingLinkRemovalUri {
    <#
    .SYNOPSIS
        Builds the Graph DELETE URI for one sharing-link descriptor.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        $Link
    )

    $linkId = [string]$Link.linkId
    $driveId = [string]$Link.driveId
    $itemId = [string]$Link.itemId
    if ([string]::IsNullOrWhiteSpace($linkId)) { throw 'sharing-links.missing_link_id' }
    if ([string]::IsNullOrWhiteSpace($driveId) -or [string]::IsNullOrWhiteSpace($itemId)) {
        throw 'sharing-links.missing_target'
    }
    return "/v1.0/drives/$driveId/items/$itemId/permissions/$linkId"
}

function Remove-SharingLinks {
    <#
    .SYNOPSIS
        Plans or applies bulk sharing-link removal.
    .PARAMETER TenantId
    .PARAMETER Links
        Link descriptors exposing at least linkId; driveId/itemId locate the
        permission, linkType gates v1 eligibility.
    .PARAMETER Mode
        Plan (default) never writes; Apply removes.
    .PARAMETER ConfirmCount
        Apply requires this to equal Links.Count.
    .PARAMETER Actor
    .PARAMETER CorrelationId
    .PARAMETER JobId
    .PARAMETER RemoveLink
        Seam: scriptblock (link) -> @{ before; after }. Defaults to the Graph DELETE.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op; audit payloads
        are still returned in auditEvents for the caller to persist.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Links,

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
        [scriptblock]$RemoveLink,

        [Parameter()]
        [scriptblock]$WriteAudit
    )

    if (-not $JobId) { $JobId = [guid]::NewGuid().ToString() }
    $now = [DateTime]::UtcNow.ToString('o')
    if (-not $RemoveLink) {
        $RemoveLink = {
            param($link)
            $uri = Get-SharingLinkRemovalUri -Link $link
            $null = Invoke-MgGraphRequest -Method 'DELETE' -Uri $uri
            return @{ before = $link; after = $null }
        }
    }
    if (-not $WriteAudit) { $WriteAudit = { param($auditEvent) } }

    if (-not $Links -or $Links.Count -eq 0) {
        throw 'sharing-links.empty_selection'
    }

    $planned = New-Object System.Collections.Generic.List[object]
    foreach ($link in $Links) {
        $linkId = [string]$link.linkId
        if ([string]::IsNullOrWhiteSpace($linkId)) {
            throw 'sharing-links.missing_link_id'
        }
        $linkType = if ($null -ne $link.linkType) { [string]$link.linkType } else { '' }
        $eligible = ([string]::IsNullOrWhiteSpace($linkType)) -or ($script:RemovableLinkTypes -contains $linkType)
        $planned.Add([ordered]@{
                linkId     = $linkId
                itemId     = [string]$link.itemId
                driveId    = [string]$link.driveId
                linkType   = $linkType
                eligible   = $eligible
                skipReason = if ($eligible) { $null } else { 'unsupported-link-type: direct-permission removal is deferred' }
            }) | Out-Null
    }

    if ($Mode -eq 'Plan') {
        return [pscustomobject]@{
            jobId   = $JobId
            tenantId = $TenantId
            mode    = 'plan'
            state   = 'planned'
            links   = $planned.ToArray()
            total   = $planned.Count
            writes  = $false
        }
    }

    if ($ConfirmCount -ne $Links.Count) {
        throw "sharing-links.confirm_required: apply removes $($Links.Count) links and requires -ConfirmCount $($Links.Count)"
    }

    $results = New-Object System.Collections.Generic.List[object]
    $audits = New-Object System.Collections.Generic.List[object]
    $removedCount = 0
    $failedCount = 0
    $skippedCount = 0

    foreach ($entry in $planned) {
        if (-not $entry.eligible) {
            $skippedCount++
            $results.Add([ordered]@{
                    linkId = $entry.linkId; state = 'skipped'
                    before = $entry; after = $null
                    appliedAt = $null; actor = $Actor
                    error = [string]$entry.skipReason
                }) | Out-Null
            continue
        }
        $link = $Links | Where-Object { [string]$_.linkId -eq [string]$entry.linkId } | Select-Object -First 1
        try {
            $outcome = & $RemoveLink $link
            $removedCount++
            $appliedAt = [DateTime]::UtcNow.ToString('o')
            $results.Add([ordered]@{
                    linkId = $entry.linkId; state = 'removed'
                    before = $outcome.before; after = $outcome.after
                    appliedAt = $appliedAt; actor = $Actor; error = $null
                }) | Out-Null
            $audit = [ordered]@{
                action = 'sharing.linkRemove'; result = 'success'; tenantId = $TenantId
                resourceId = $entry.linkId; before = $outcome.before; after = $outcome.after
                actorUserId = $Actor; correlationId = $CorrelationId; timestamp = $appliedAt
            }
            & $WriteAudit $audit
            $audits.Add($audit) | Out-Null
        }
        catch {
            $failedCount++
            $failedAt = [DateTime]::UtcNow.ToString('o')
            $message = $_.Exception.Message
            $results.Add([ordered]@{
                    linkId = $entry.linkId; state = 'failed'
                    before = $entry; after = $null
                    appliedAt = $failedAt; actor = $Actor; error = $message
                }) | Out-Null
            $audit = [ordered]@{
                action = 'sharing.linkRemove'; result = 'failure'; tenantId = $TenantId
                resourceId = $entry.linkId; before = $entry; after = $null; error = $message
                actorUserId = $Actor; correlationId = $CorrelationId; timestamp = $failedAt
            }
            & $WriteAudit $audit
            $audits.Add($audit) | Out-Null
        }
    }

    $state = if ($failedCount -gt 0) { 'failed' } else { 'completed' }
    $linkIds = @($planned | ForEach-Object { [string]$_.linkId })
    return [pscustomobject]@{
        jobId    = $JobId
        tenantId = $TenantId
        mode     = 'apply'
        state    = $state
        results  = $results.ToArray()
        auditEvents = $audits.ToArray()
        summary  = [pscustomobject]@{
            total   = $planned.Count
            removed = $removedCount
            failed  = $failedCount
            skipped = $skippedCount
        }
        job      = [pscustomobject]@{
            id        = $JobId
            tenantId  = $TenantId
            linkIds   = $linkIds
            state     = $state
            results   = $results.ToArray()
            createdAt = $now
            createdBy = $Actor
        }
    }
}
