# Sync-GdapTenants.ps1 — EPIC-002 GDAP tenant discovery worker (SPEC §4.3, §6).
#
# Enumerates Partner Center / Graph delegatedAdminRelationships.
# Upserts tenants with source: 'gdap' and relationship metadata.
# Unavailable or expired relationships are marked excluded, not silently dropped.
# Direct tenants are strictly unaffected.

[CmdletBinding()]
param(
    [Parameter()]
    [string]$PartnerTenantId,

    [Parameter()]
    [string]$GraphApiEndpoint = 'https://graph.microsoft.com/v1.0',

    [Parameter()]
    [scriptblock]$GraphRequestHandler,

    [Parameter()]
    [string]$DefaultCpvConsentState = 'active'
)

function Sync-GdapTenants {
    <#
    .SYNOPSIS
        Discovers partner tenants from delegated admin relationships.
    .DESCRIPTION
        Queries tenantRelationships/delegatedAdminRelationships and produces
        tenant records (source: 'gdap') and GdapRelationship satellite records.
        Relationships that are inactive, terminated, or expiring are preserved
        and marked excluded with an explicit excludeReason.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$PartnerTenantId,

        [Parameter()]
        [string]$GraphApiEndpoint = 'https://graph.microsoft.com/v1.0',

        [Parameter()]
        [scriptblock]$GraphRequestHandler,

        [Parameter()]
        [string]$DefaultCpvConsentState = 'active'
    )

    $nowIso = (Get-Date).ToUniversalTime().ToString('o')
    $discoveredTenants = @()
    $discoveredRelationships = @()

    $uri = "$GraphApiEndpoint/tenantRelationships/delegatedAdminRelationships"
    $response = $null

    try {
        if ($GraphRequestHandler) {
            $response = & $GraphRequestHandler -Uri $uri -Method 'GET'
        }
        elseif (Get-Command -Name 'Invoke-MgGraphRequest' -ErrorAction SilentlyContinue) {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        }
        else {
            throw "No Graph API request handler available to query delegatedAdminRelationships."
        }
    }
    catch {
        throw "Failed to enumerate delegatedAdminRelationships: $($_.Exception.Message) (code: gdap.enumeration_failed)"
    }

    $items = @()
    if ($response.value) {
        $items = @($response.value)
    }
    elseif ($response -is [System.Collections.IEnumerable]) {
        $items = @($response)
    }

    foreach ($item in $items) {
        $cust = $item.customer
        $tenantId = if ($cust.tenantId) { [string]$cust.tenantId } else { [string]$item.customerTenantId }
        $displayName = if ($cust.displayName) { [string]$cust.displayName } else { [string]$item.customerDisplayName }

        if (-not $tenantId) {
            continue
        }

        $relStatus = ([string]$item.status).ToLowerInvariant()
        $isActive = ($relStatus -eq 'active')
        $isExcluded = (-not $isActive)
        $excludeReason = if ($isExcluded) {
            "GDAP relationship is $relStatus"
        } else {
            $null
        }

        $discoveredTenants += [pscustomobject]@{
            id            = $tenantId
            displayName   = $displayName
            defaultDomain = $null
            initialDomain = $null
            source        = 'gdap'
            status        = if ($isExcluded) { 'excluded' } else { 'active' }
            excluded      = $isExcluded
            excludeReason = $excludeReason
            excludeDate   = if ($isExcluded) { $nowIso } else { $null }
            environment   = 'commercial'
            errorCount    = 0
            lastError     = $null
            lastRunAt     = $null
        }

        $cpvState = if ($item.cpvConsentState) {
            [string]$item.cpvConsentState
        } else {
            $DefaultCpvConsentState
        }

        $discoveredRelationships += [pscustomobject]@{
            tenantId                 = $tenantId
            relationshipEnd          = [string]$item.endDateTime
            delegatedPrivilegeStatus = [string]$item.status
            cpvConsentState          = $cpvState
            lastSynced               = $nowIso
        }
    }

    return [pscustomobject]@{
        syncedAt        = $nowIso
        totalDiscovered = $discoveredTenants.Count
        tenants         = @($discoveredTenants)
        relationships   = @($discoveredRelationships)
    }
}

if ($GraphRequestHandler) {
    return (Sync-GdapTenants -PartnerTenantId $PartnerTenantId `
                             -GraphApiEndpoint $GraphApiEndpoint `
                             -GraphRequestHandler $GraphRequestHandler `
                             -DefaultCpvConsentState $DefaultCpvConsentState)
}
