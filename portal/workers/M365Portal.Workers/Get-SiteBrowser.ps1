# Get-SiteBrowser.ps1 — EPIC-025 site browser (SPEC §2 US-5, §3.4, §4.3, §6; T-0488).
#
# Read-only worker handler: enumerates one site's document libraries, their
# top-level items, the site permission grants, and the external users reachable
# through those grants, live from Graph. Permission changes are not performed
# here — the result carries the EPIC-027 hand-off paths. The worker is
# read-only: only GET requests are issued.

function Read-SiteBrowserJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-SiteBrowser.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }

    $raw = Get-Content -LiteralPath $Path -Raw
    $json = $raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }
    if (-not $json.siteId) {
        throw "job envelope '$Path' is missing mandatory 'siteId'"
    }

    return @{
        TenantId = [string]$json.tenantId
        SiteId   = [string]$json.siteId
    }
}

function Get-SiteBrowserAdminCenterUrl {
    <#
    .SYNOPSIS
        Builds the SharePoint admin-center deep link for a site (SPEC §11 item 4).
    .DESCRIPTION
        Advanced actions (site collection upgrade, term store, tenant-level sharing
        settings) stay in the SPO admin center in v1. A Graph site id is
        '<host>,<siteCollectionGuid>,<webGuid>'; the admin center keys on the site
        collection guid, so extract it when present.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId
    )

    $parts = @($SiteId.Split(','))
    $adminSiteId = if ($parts.Count -eq 3 -and -not [string]::IsNullOrWhiteSpace($parts[1])) { $parts[1] } else { $SiteId }
    return "https://admin.microsoft.com/sharepoint?page=siteDetails&modern=true&siteId=$adminSiteId"
}

function ConvertTo-SiteBrowserLibrary {
    <#
    .SYNOPSIS
        Maps a Graph drive (document library) to a browser library entry.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Drive
    )

    $quotaUsed = $null
    $quotaTotal = $null
    if ($null -ne $Drive.quota) {
        if ($null -ne $Drive.quota.used) { $quotaUsed = [long]$Drive.quota.used }
        if ($null -ne $Drive.quota.total) { $quotaTotal = [long]$Drive.quota.total }
    }

    return [pscustomobject]@{
        id             = if ($Drive.id) { [string]$Drive.id } else { '' }
        name           = if ($Drive.name) { [string]$Drive.name } else { '' }
        webUrl         = if ($Drive.webUrl) { [string]$Drive.webUrl } else { '' }
        driveType      = if ($Drive.driveType) { [string]$Drive.driveType } else { '' }
        quotaUsedBytes = $quotaUsed
        quotaTotalBytes = $quotaTotal
    }
}

function ConvertTo-SiteBrowserItem {
    <#
    .SYNOPSIS
        Maps a Graph driveItem to a browser item entry.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Item,

        [Parameter(Mandatory)]
        [string]$LibraryId,

        [Parameter(Mandatory)]
        [string]$LibraryName
    )

    $size = $null
    if ($null -ne $Item.size) { $size = [long]$Item.size }

    return [pscustomobject]@{
        id                   = if ($Item.id) { [string]$Item.id } else { '' }
        name                 = if ($Item.name) { [string]$Item.name } else { '' }
        webUrl               = if ($Item.webUrl) { [string]$Item.webUrl } else { '' }
        libraryId            = $LibraryId
        libraryName          = $LibraryName
        isFolder             = $null -ne $Item.folder
        sizeBytes            = $size
        lastModifiedDateTime = if ($Item.lastModifiedDateTime) { [string]$Item.lastModifiedDateTime } else { $null }
    }
}

function Get-SiteBrowserPermissionIdentities {
    <#
    .SYNOPSIS
        Resolves the granted identities from a Graph permission object.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Permission
    )

    $identities = [System.Collections.Generic.List[object]]::new()
    $containers = [System.Collections.Generic.List[object]]::new()
    if ($null -ne $Permission.grantedToIdentitiesV2) {
        foreach ($entry in @($Permission.grantedToIdentitiesV2)) {
            if ($null -ne $entry) { $containers.Add($entry) | Out-Null }
        }
    }
    if ($null -ne $Permission.grantedToV2) {
        $containers.Add($Permission.grantedToV2) | Out-Null
    }

    foreach ($container in $containers) {
        foreach ($kind in @('user', 'siteUser', 'group', 'application', 'device')) {
            $identity = $container.$kind
            if ($null -eq $identity) { continue }
            $identities.Add([pscustomobject]@{
                principalType = $kind
                displayName   = if ($identity.displayName) { [string]$identity.displayName } else { '' }
                email         = if ($identity.email) { [string]$identity.email } else { '' }
                loginName     = if ($identity.loginName) { [string]$identity.loginName } else { '' }
                userType      = if ($identity.userType) { [string]$identity.userType } else { '' }
            }) | Out-Null
        }
    }

    return $identities
}

function Test-SiteBrowserIdentityExternal {
    <#
    .SYNOPSIS
        True when a granted identity is external (guest) to the tenant.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Identity
    )

    if ([string]$Identity.userType -eq 'Guest') { return $true }
    if ([string]$Identity.loginName -match '#ext#') { return $true }
    if ([string]$Identity.email -match '#ext#') { return $true }
    return $false
}

function ConvertTo-SiteBrowserPermissionRows {
    <#
    .SYNOPSIS
        Flattens a Graph permission into one browser row per granted identity.
    .DESCRIPTION
        A permission with no granted identity is a sharing link and becomes a
        single 'link' row; anonymous links are external. One row per identity
        keeps the permissions table flat and easy to render.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Permission
    )

    $rows = [System.Collections.Generic.List[object]]::new()
    $id = if ($Permission.id) { [string]$Permission.id } else { '' }
    $roles = @()
    if ($null -ne $Permission.roles) {
        $roles = @($Permission.roles | ForEach-Object { [string]$_ })
    }
    $linkType = ''
    if ($null -ne $Permission.link -and $null -ne $Permission.link.scope) {
        $linkType = [string]$Permission.link.scope
    }

    $identities = @(Get-SiteBrowserPermissionIdentities -Permission $Permission)
    if ($identities.Count -eq 0) {
        $rows.Add([pscustomobject]@{
            id            = $id
            roles         = $roles
            principalType = 'link'
            displayName   = $linkType
            email         = ''
            loginName     = ''
            userType      = ''
            external      = ($linkType -eq 'anonymous')
            linkType      = $linkType
        }) | Out-Null
        return $rows
    }

    foreach ($identity in $identities) {
        $rows.Add([pscustomobject]@{
            id            = $id
            roles         = $roles
            principalType = $identity.principalType
            displayName   = $identity.displayName
            email         = $identity.email
            loginName     = $identity.loginName
            userType      = $identity.userType
            external      = (Test-SiteBrowserIdentityExternal -Identity $identity)
            linkType      = $linkType
        }) | Out-Null
    }

    return $rows
}

function Get-SiteBrowserExternalUsers {
    <#
    .SYNOPSIS
        Deduplicates the external identities out of the permission rows.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [object[]]$Permissions = @()
    )

    $users = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($permission in $Permissions) {
        if ($null -eq $permission -or -not $permission.external) { continue }
        $key = if ($permission.email) { [string]$permission.email } elseif ($permission.loginName) { [string]$permission.loginName } else { [string]$permission.displayName }
        if ([string]::IsNullOrWhiteSpace($key)) { continue }
        if (-not $seen.Add($key)) { continue }
        $users.Add([pscustomobject]@{
            displayName   = [string]$permission.displayName
            email         = [string]$permission.email
            loginName     = [string]$permission.loginName
            principalType = [string]$permission.principalType
            permissionId  = [string]$permission.id
            roles         = @($permission.roles)
        }) | Out-Null
    }

    return $users
}

function Get-SiteBrowser {
    <#
    .SYNOPSIS
        Browsers a SharePoint site: libraries, items, permissions, external users.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId
    )

    $site = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/sites/$SiteId?`$select=id,displayName,webUrl"
    $siteUrl = if ($null -ne $site -and $site.webUrl) { [string]$site.webUrl } else { '' }

    $libraries = [System.Collections.Generic.List[object]]::new()
    $items = [System.Collections.Generic.List[object]]::new()
    $drivesResponse = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/sites/$SiteId/drives?`$select=id,name,webUrl,driveType,quota"
    if ($null -ne $drivesResponse) {
        foreach ($drive in @($drivesResponse.value)) {
            if ($null -eq $drive) { continue }
            $library = ConvertTo-SiteBrowserLibrary -Drive $drive
            $libraries.Add($library) | Out-Null

            try {
                $childrenUri = "/v1.0/drives/$($library.id)/root/children?`$select=id,name,webUrl,size,folder,file,lastModifiedDateTime&`$top=200"
                $childrenResponse = Invoke-MgGraphRequest -Method GET -Uri $childrenUri
                if ($null -ne $childrenResponse) {
                    foreach ($child in @($childrenResponse.value)) {
                        if ($null -eq $child) { continue }
                        $items.Add((ConvertTo-SiteBrowserItem -Item $child -LibraryId $library.id -LibraryName $library.name)) | Out-Null
                    }
                }
            }
            catch {
                Write-Verbose "Could not list items for library '$($library.id)': $($_.Exception.Message)"
            }
        }
    }

    $permissions = [System.Collections.Generic.List[object]]::new()
    try {
        $permissionsResponse = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/sites/$SiteId/permissions"
        if ($null -ne $permissionsResponse) {
            foreach ($grant in @($permissionsResponse.value)) {
                if ($null -eq $grant) { continue }
                foreach ($row in @(ConvertTo-SiteBrowserPermissionRows -Permission $grant)) {
                    $permissions.Add($row) | Out-Null
                }
            }
        }
    }
    catch {
        Write-Verbose "Could not list permissions for site '$SiteId': $($_.Exception.Message)"
    }

    $externalUsers = @(Get-SiteBrowserExternalUsers -Permissions @($permissions))

    return [pscustomobject]@{
        tenantId       = $TenantId
        siteId         = $SiteId
        siteUrl        = $siteUrl
        adminCenterUrl = Get-SiteBrowserAdminCenterUrl -SiteId $SiteId
        libraries      = @($libraries)
        items          = @($items)
        permissions    = @($permissions)
        externalUsers  = $externalUsers
        handoff        = [pscustomobject]@{
            permissionEdits        = $false
            sharingPermissionsPath = "/v1/tenants/$TenantId/sharing/permissions"
            externalUsersPath      = "/v1/tenants/$TenantId/sharing/external-users"
            sharingLinksRemovePath = "/v1/tenants/$TenantId/sharing/links/remove"
        }
    }
}
