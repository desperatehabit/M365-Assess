# Get-PermissionsReport.ps1 — EPIC-027 site/OneDrive permissions report read
# (EPIC-027 SPEC.md §2 US-2, §3.2, §4.1, §6; T-0523).
#
# Live Graph reads only: the worker takes the T-0482 site list (Get-SharePointSites),
# then for every site reads its permission objects (/sites/{id}/permissions) and
# flattens them into the §3.2 rows (Site · Principal · Role · Inherited · Scope),
# applies the optional role and principal-type filters, and returns one cursor page.
# Only GET requests are issued; nothing is written to the tenant and nothing is
# mirrored to disk. Filtering happens here so the BFF never materializes a large
# tenant's full permission set.

. (Join-Path -Path $PSScriptRoot -ChildPath 'Get-SharePointSites.ps1')

function ConvertTo-PermissionsReportCursor {
    <#
    .SYNOPSIS
        Encodes a row offset into the opaque report cursor.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-PermissionsReportCursor {
    <#
    .SYNOPSIS
        Decodes the opaque report cursor back into a row offset.
    .DESCRIPTION
        An undecodable cursor restarts at the first page instead of failing the
        read; the report is read-only, so a bad cursor must not be fatal.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [string]$Cursor = ''
    )

    if ([string]::IsNullOrWhiteSpace($Cursor)) { return 0 }
    try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Cursor))
        if ($decoded -match '^offset:(\d+)$') {
            return [int]$Matches[1]
        }
        return 0
    }
    catch {
        return 0
    }
}

function Get-PermissionPrincipal {
    <#
    .SYNOPSIS
        Maps a Graph permission's identity to the §3.2 principal columns.
    .DESCRIPTION
        Reads grantedToV2 / grantedToIdentitiesV2 / grantedTo and returns the
        display name, id, and the principal type filter value (user, group,
        servicePrincipal). A link with no identity falls back to its scope.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Permission
    )

    $identity = $null
    if ($null -ne $Permission.grantedToV2) {
        $identity = $Permission.grantedToV2
    }
    elseif ($null -ne $Permission.grantedToIdentitiesV2 -and @($Permission.grantedToIdentitiesV2).Count -gt 0) {
        $identity = @($Permission.grantedToIdentitiesV2)[0]
    }
    elseif ($null -ne $Permission.grantedTo) {
        $identity = $Permission.grantedTo
    }

    $name = ''
    $id = ''
    $type = 'user'
    if ($null -ne $identity) {
        foreach ($kind in @('user', 'siteUser', 'group', 'siteGroup', 'application', 'device')) {
            $entry = $identity.$kind
            if ($null -eq $entry) { continue }
            switch ($kind) {
                'group' { $type = 'group' }
                'siteGroup' { $type = 'group' }
                'application' { $type = 'servicePrincipal' }
                default { $type = 'user' }
            }
            if ($entry.displayName) { $name = [string]$entry.displayName }
            elseif ($entry.userPrincipalName) { $name = [string]$entry.userPrincipalName }
            elseif ($entry.email) { $name = [string]$entry.email }
            if ($entry.id) { $id = [string]$entry.id }
            break
        }
    }

    if ([string]::IsNullOrWhiteSpace($name)) {
        if ($null -ne $Permission.link -and $Permission.link.scope) {
            $name = [string]$Permission.link.scope
        }
        else {
            $name = 'unknown'
        }
    }
    if ([string]::IsNullOrWhiteSpace($id)) { $id = $name }

    return [pscustomobject]@{ name = $name; id = $id; type = $type }
}

function ConvertTo-PermissionReportRow {
    <#
    .SYNOPSIS
        Shapes one Graph permission object into a §3.2 report row.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Site,

        [Parameter(Mandatory)]
        [object]$Permission
    )

    $principal = Get-PermissionPrincipal -Permission $Permission
    $roles = @($Permission.roles | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    $role = if ($roles.Count -gt 0) { [string]($roles -join ', ') } else { '' }
    $scope = 'site'
    if ($null -ne $Permission.link -and $Permission.link.scope) {
        $scope = [string]$Permission.link.scope
    }

    return [pscustomobject]@{
        site          = if ($Site.name) { [string]$Site.name } else { [string]$Site.id }
        siteId        = [string]$Site.id
        principal     = $principal.name
        principalId   = $principal.id
        principalType = $principal.type
        role          = $role
        roles         = $roles
        inherited     = [bool]($null -ne $Permission.inheritedFrom)
        scope         = $scope
    }
}

function Test-PermissionReportFilter {
    <#
    .SYNOPSIS
        Returns whether a §3.2 row matches the role and principal-type filters.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Role = '',

        [Parameter()]
        [string]$PrincipalType = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Role)) {
        $wanted = $Role.ToLowerInvariant()
        $matched = @($Row.roles | Where-Object { ([string]$_).ToLowerInvariant() -eq $wanted }).Count -gt 0
        if (-not $matched) { return $false }
    }

    if (-not [string]::IsNullOrWhiteSpace($PrincipalType)) {
        if ($Row.principalType -ne $PrincipalType) { return $false }
    }

    return $true
}

function Get-PermissionsReport {
    <#
    .SYNOPSIS
        Lists tenant site/OneDrive permissions live from Graph.
    .DESCRIPTION
        Uses the T-0482 site list, reads each site's permission objects, shapes
        the §3.2 rows, applies the optional role and principal-type filters, and
        returns one cursor page. Only GET requests are issued; nothing is written
        to the tenant and nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the permissions belong to. Carried through to the result.
    .PARAMETER Role
        Case-insensitive exact match against a row's roles (read/write/owner/...).
    .PARAMETER PrincipalType
        user, group, or servicePrincipal.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-PermissionsReport -TenantId 'tenant-a' -Role 'owner' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Role = '',

        [Parameter()]
        [ValidateSet('', 'user', 'group', 'servicePrincipal')]
        [string]$PrincipalType = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $sites = Get-SharePointSites -TenantId $TenantId -Top 1000

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($site in @($sites.items)) {
        if ($null -eq $site -or [string]::IsNullOrWhiteSpace([string]$site.id)) { continue }
        try {
            $response = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/sites/$($site.id)/permissions"
        }
        catch {
            Write-Verbose "Permissions unavailable for site '$($site.id)': $($_.Exception.Message)"
            continue
        }
        foreach ($permission in @($response.value)) {
            if ($null -eq $permission) { continue }
            $row = ConvertTo-PermissionReportRow -Site $site -Permission $permission
            if (Test-PermissionReportFilter -Row $row -Role $Role -PrincipalType $PrincipalType) {
                $rows.Add($row)
            }
        }
    }

    $offset = ConvertFrom-PermissionsReportCursor -Cursor $Cursor
    $page = @($rows | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $rows.Count) {
        $nextCursor = ConvertTo-PermissionsReportCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        totalCount  = $rows.Count
        items       = @($page)
        nextCursor  = $nextCursor
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-PermissionsReportJob {
    <#
    .SYNOPSIS
        Reads a feature job envelope file into Get-PermissionsReport parameters.
    .DESCRIPTION
        Validates the tenant id and carries the optional role, principal-type, and
        pagination fields. The envelope carries references only; secrets are never
        present and never needed here.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Permissions report job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Permissions report job is missing required field: tenantId'
    }

    return @{
        TenantId      = $tenantId
        Role          = [string]$job['role']
        PrincipalType = [string]$job['principalType']
        Top           = if ($job['top']) { [int]$job['top'] } else { 100 }
        Cursor        = [string]$job['cursor']
    }
}
