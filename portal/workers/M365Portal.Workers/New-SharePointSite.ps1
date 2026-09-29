# New-SharePointSite.ps1 — EPIC-025 site create worker (SPEC §4.1, §6, §8; T-0484).
#
# Applies a planned single site create live against Graph with before/after
# capture and one audit record. Site create is not a registry CheckId command,
# so it cannot travel the CheckId-bound executor path; it follows the same
# EPIC-006 contract instead — the BFF confirms the plan before dispatch
# (dryRun plans only), -DryRun reports the intended change without writing,
# and every applied row captures before (absent) and after (created site).
# The Graph session is connected by the supervisor after materializing the
# tenant credential in-process; this file never touches secrets.

$script:SharePointSiteTypes = @('team', 'communication')
$script:SharePointSharingOptions = @('disabled', 'externalUserSharingOnly', 'externalUserAndGuestSharing')

function Test-SharePointSiteInput {
    <#
    .SYNOPSIS
        Validates one planned SharePoint site create.
    .DESCRIPTION
        Mirrors the CSV schema fixed in T-0484 (SPEC §11 item 3): name, alias
        (site URL slug), type (team|communication), owners (at least one UPN),
        optional template, and sharing
        (disabled|externalUserSharingOnly|externalUserAndGuestSharing). Returns
        the error list; an empty list is valid.
    .PARAMETER Site
        Planned site object (name, alias, type, owners, template, sharing).
    .EXAMPLE
        Test-SharePointSiteInput -Site $site
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [object]$Site
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    $name = [string]$Site.name
    $alias = [string]$Site.alias
    $type = [string]$Site.type
    $sharing = [string]$Site.sharing
    if ([string]::IsNullOrWhiteSpace($name)) {
        $errors.Add('name is required')
    }
    if ([string]::IsNullOrWhiteSpace($alias)) {
        $errors.Add('alias is required')
    }
    elseif ($alias.Trim() -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') {
        $errors.Add("alias '$($alias.Trim())' must be a valid site URL slug")
    }
    if ([string]::IsNullOrWhiteSpace($type)) {
        $errors.Add('type is required (team|communication)')
    }
    elseif (@('team', 'communication') -notcontains $type.Trim().ToLowerInvariant()) {
        $errors.Add("type '$($type.Trim())' must be team or communication")
    }
    $owners = @()
    if ($null -ne $Site.owners) {
        if ($Site.owners -is [string]) {
            $owners = @($Site.owners -split ';')
        }
        else {
            $owners = @($Site.owners)
        }
    }
    $owners = @($owners | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -ne '' })
    if ($owners.Count -eq 0) {
        $errors.Add('owners is required (at least one owner UPN)')
    }
    else {
        foreach ($owner in $owners) {
            if ($owner -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
                $errors.Add("owner '$owner' is not a valid UPN")
            }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($sharing)) {
        if ($script:SharePointSharingOptions -notcontains $sharing.Trim()) {
            $errors.Add("sharing '$($sharing.Trim())' must be disabled, externalUserSharingOnly, or externalUserAndGuestSharing")
        }
    }
    return @($errors)
}

function New-SharePointSite {
    <#
    .SYNOPSIS
        Creates one SharePoint site live against Graph with before/after capture.
    .DESCRIPTION
        Validates the planned site, then creates it (team sites via /groups,
        communication sites via /sites), attaches owners, and applies the
        sharing setting. -DryRun returns the intended change with no Graph
        write. Every outcome is reported through -WriteAudit with before
        (absent) and after (created site or null). Apply failures are returned,
        not thrown, so bulk callers continue with siblings.
    .PARAMETER TenantId
        Tenant the site belongs to. Carried through to the result envelope.
    .PARAMETER Site
        Planned site object (name, alias, type, owners, template, sharing).
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        New-SharePointSite -TenantId 'tenant-a' -Site $site -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [object]$Site,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $name = ([string]$Site.name).Trim()
    $alias = ([string]$Site.alias).Trim()
    $type = ([string]$Site.type).Trim().ToLowerInvariant()
    $template = ([string]$Site.template).Trim()
    $sharing = ([string]$Site.sharing).Trim()
    if ($sharing.Length -eq 0) {
        $sharing = 'disabled'
    }
    $owners = @()
    if ($Site.owners -is [string]) {
        $owners = @($Site.owners -split ';')
    }
    else {
        $owners = @($Site.owners)
    }
    $owners = @($owners | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -ne '' })

    $failures = @(Test-SharePointSiteInput -Site $Site)
    if ($failures.Count -gt 0) {
        return [pscustomobject]@{
            name   = $name
            alias  = $alias
            type   = $type
            status = 'failed'
            id     = $null
            error  = ($failures -join '; ')
            before = $null
            after  = $null
        }
    }

    $intended = [pscustomobject]@{
        name     = $name
        alias    = $alias
        type     = $type
        owners   = $owners
        template = $template
        sharing  = $sharing
    }
    if ($DryRun) {
        return [pscustomobject]@{
            name   = $name
            alias  = $alias
            type   = $type
            status = 'planned'
            id     = $null
            error  = $null
            before = $null
            after  = $intended
        }
    }

    try {
        $siteId = ''
        if ($type -eq 'team') {
            $groupBody = @{
                displayName     = $name
                mailNickname    = $alias
                mailEnabled     = $true
                securityEnabled = $false
                groupTypes      = @('Unified')
            }
            if ($template.Length -gt 0) {
                $groupBody['classification'] = $template
            }
            $created = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/groups' -Body ($groupBody | ConvertTo-Json -Depth 5)
            $siteId = [string]$created.id
            foreach ($owner in $owners) {
                $ownerUser = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/users/$owner"
                $refBody = @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$([string]$ownerUser.id)" }
                $null = Invoke-MgGraphRequest -Method POST -Uri "/v1.0/groups/$siteId/owners/`$ref" -Body ($refBody | ConvertTo-Json -Depth 5)
            }
        }
        else {
            $siteBody = @{
                displayName = $name
                name        = $alias
            }
            if ($template.Length -gt 0) {
                $siteBody['template'] = $template
            }
            $created = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/sites' -Body ($siteBody | ConvertTo-Json -Depth 5)
            $siteId = [string]$created.id
            foreach ($owner in $owners) {
                $permBody = @{
                    roles               = @('owner')
                    grantedToIdentities = @(@{ user = @{ userPrincipalName = $owner } })
                }
                $null = Invoke-MgGraphRequest -Method POST -Uri "/v1.0/sites/$siteId/permissions" -Body ($permBody | ConvertTo-Json -Depth 5)
            }
        }
        $shareBody = @{ sharingCapability = $sharing }
        $null = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/sites/$siteId" -Body ($shareBody | ConvertTo-Json -Depth 5)

        $after = [pscustomobject]@{
            id       = $siteId
            name     = $name
            alias    = $alias
            type     = $type
            owners   = $owners
            template = $template
            sharing  = $sharing
        }
        $null = & $WriteAudit @{
            tenantId      = $TenantId
            action        = 'sharepoint.site.create'
            result        = 'success'
            error         = $null
            before        = $null
            after         = $after
            actor         = $Actor
            correlationId = $CorrelationId
        }
        return [pscustomobject]@{
            name   = $name
            alias  = $alias
            type   = $type
            status = 'created'
            id     = $siteId
            error  = $null
            before = $null
            after  = $after
        }
    }
    catch {
        $message = $_.Exception.Message
        $null = & $WriteAudit @{
            tenantId      = $TenantId
            action        = 'sharepoint.site.create'
            result        = 'failure'
            error         = $message
            before        = $null
            after         = $null
            actor         = $Actor
            correlationId = $CorrelationId
        }
        return [pscustomobject]@{
            name   = $name
            alias  = $alias
            type   = $type
            status = 'failed'
            id     = $null
            error  = $message
            before = $null
            after  = $null
        }
    }
}

function Read-SharePointSiteCreateJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into New-SharePointSite parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        planned site (payload.site) with the dry-run flag. The envelope carries
        references and planned values only; secrets are never present here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SharePointSiteCreateJob -Path './run/site-create-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "SharePoint site create job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "SharePoint site create job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'SharePoint site create job is missing required field: tenantId'
    }
    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    if ($null -eq $payload['site']) {
        throw 'SharePoint site create job is missing required field: payload.site'
    }
    return @{
        TenantId = $tenantId
        Site     = $payload['site']
        DryRun   = ($payload['dryRun'] -eq $true)
    }
}
