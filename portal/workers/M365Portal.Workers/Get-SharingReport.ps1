# Get-SharingReport.ps1 — EPIC-027 sharing-links report (SPEC §2 US-1, §3.1, §4.1, §6; T-0521).
#
# Read-only worker handler: enumerates the tenant's sharing links live from Graph
# (Sites.ReadWrite.All, app-only per §7) by walking each site/OneDrive drive from
# the T-0482 site list, and maps each link permission to the §3.1 columns —
# Site/OneDrive, Item, Link type (anonymous/organization/people), Permissions
# (view/edit), Created by, Created, Expires — with filters for link type,
# permissions, site, created date, and anonymous-only, plus cursor pagination.
# Filtering happens here so the BFF never materializes a large tenant's full
# link list. The worker is read-only: only GET requests are issued.

. (Join-Path -Path $PSScriptRoot -ChildPath 'Get-SharePointSites.ps1')

function Read-SharingReportJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-SharingReport.
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

    $result = @{
        TenantId      = [string]$json.tenantId
        LinkType      = if ($json.linkType) { [string]$json.linkType } else { '' }
        Permissions   = if ($json.permissions) { [string]$json.permissions } else { '' }
        Site          = if ($json.site) { [string]$json.site } else { '' }
        CreatedAfter  = if ($json.createdAfter) { [string]$json.createdAfter } else { '' }
        AnonymousOnly = if ($null -ne $json.anonymousOnly) { [bool]$json.anonymousOnly } else { $false }
        Top           = if ($json.top) { [int]$json.top } else { 100 }
        Cursor        = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-SharingReportCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-SharingReportCursor {
    param([string]$Cursor)
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

function ConvertTo-SharingReportLinkType {
    param([string]$Scope)
    switch ($Scope.ToLowerInvariant()) {
        'anonymous' { return 'anonymous' }
        'organization' { return 'organization' }
        'users' { return 'people' }
        default { return $Scope.ToLowerInvariant() }
    }
}

function ConvertTo-SharingReportPermissions {
    param([string]$Type)
    $raw = $Type.ToLowerInvariant()
    if ($raw -eq 'edit') { return 'edit' }
    if ($raw -eq 'view' -or $raw -eq 'embed') { return 'view' }
    return $raw
}

function ConvertTo-SharingReportRow {
    param(
        [Parameter(Mandatory)]
        [object]$Site,

        [Parameter(Mandatory)]
        [object]$Item,

        [Parameter(Mandatory)]
        [object]$Permission,

        [Parameter(Mandatory)]
        [string]$DriveId
    )

    if ($null -eq $Permission.link) { return $null }

    $linkType = if ($Permission.link.scope) { ConvertTo-SharingReportLinkType -Scope ([string]$Permission.link.scope) } else { '' }
    $permissions = if ($Permission.link.type) { ConvertTo-SharingReportPermissions -Type ([string]$Permission.link.type) } else { '' }

    $createdBy = ''
    if ($null -ne $Permission.createdBy -and $null -ne $Permission.createdBy.user) {
        $user = $Permission.createdBy.user
        $createdBy = if ($user.userPrincipalName) { [string]$user.userPrincipalName } elseif ($user.email) { [string]$user.email } else { [string]$user.displayName }
    }

    $created = if ($Permission.createdDateTime) { [string]$Permission.createdDateTime } else { $null }
    $expires = if ($Permission.expirationDateTime) { [string]$Permission.expirationDateTime } else { $null }

    return [pscustomobject]@{
        siteId      = if ($Site.id) { [string]$Site.id } else { '' }
        siteName    = if ($Site.name) { [string]$Site.name } else { '' }
        siteUrl     = if ($Site.url) { [string]$Site.url } else { '' }
        itemId      = if ($Item.id) { [string]$Item.id } else { '' }
        itemName    = if ($Item.name) { [string]$Item.name } else { '' }
        itemUrl     = if ($Item.webUrl) { [string]$Item.webUrl } else { '' }
        driveId     = $DriveId
        linkId      = if ($Permission.id) { [string]$Permission.id } else { '' }
        linkType    = $linkType
        permissions = $permissions
        createdBy   = $createdBy
        created     = $created
        expires     = $expires
    }
}

function Test-SharingReportFilter {
    param(
        [object]$Row,
        [string]$LinkType = '',
        [string]$Permissions = '',
        [string]$Site = '',
        [string]$CreatedAfter = '',
        [bool]$AnonymousOnly = $false
    )

    if ($AnonymousOnly -and $Row.linkType.ToLowerInvariant() -ne 'anonymous') {
        return $false
    }

    if (-not [string]::IsNullOrWhiteSpace($LinkType)) {
        if ($Row.linkType.ToLowerInvariant() -ne $LinkType.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Permissions)) {
        if ($Row.permissions.ToLowerInvariant() -ne $Permissions.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Site)) {
        $needle = $Site.ToLowerInvariant()
        $haystack = ("{0} {1} {2}" -f $Row.siteId, $Row.siteName, $Row.siteUrl).ToLowerInvariant()
        if (-not $haystack.Contains($needle)) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($CreatedAfter)) {
        if ($null -eq $Row.created) { return $false }
        if ([datetime]$Row.created -lt [datetime]$CreatedAfter) { return $false }
    }

    return $true
}

function Get-SharingReportDriveItems {
    <#
    .SYNOPSIS
        Walks a drive from its root and returns the root plus every descendant item.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$DriveId
    )

    $items = [System.Collections.Generic.List[object]]::new()
    $folders = [System.Collections.Generic.Queue[string]]::new()

    $root = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/drives/$DriveId/root?`$select=id,name,webUrl,folder"
    if ($null -ne $root) {
        $items.Add($root)
        $folders.Enqueue([string]$root.id)
    }

    while ($folders.Count -gt 0) {
        $parentId = $folders.Dequeue()
        $uri = "/v1.0/drives/$DriveId/items/$parentId/children?`$select=id,name,webUrl,folder&`$top=200"
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            if ($null -ne $response -and $null -ne $response.value) {
                foreach ($child in @($response.value)) {
                    if ($null -eq $child) { continue }
                    $items.Add($child)
                    if ($null -ne $child.folder) {
                        $folders.Enqueue([string]$child.id)
                    }
                }
            }
            $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
        } while ($uri)
    }

    return $items
}

function Get-SharingReport {
    <#
    .SYNOPSIS
        Lists tenant sharing links live from Graph with the §3.1 columns and filters.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateSet('', 'anonymous', 'organization', 'people')]
        [string]$LinkType = '',

        [Parameter()]
        [ValidateSet('', 'view', 'edit')]
        [string]$Permissions = '',

        [Parameter()]
        [string]$Site = '',

        [Parameter()]
        [string]$CreatedAfter = '',

        [Parameter()]
        [bool]$AnonymousOnly = $false,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = '',

        [Parameter()]
        [AllowNull()]
        [object[]]$Sites = $null
    )

    if ($null -eq $Sites) {
        $Sites = @((Get-SharePointSites -TenantId $TenantId).items)
    }

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($siteEntry in $Sites) {
        if ($null -eq $siteEntry) { continue }
        $siteId = [string]$siteEntry.id
        if ([string]::IsNullOrWhiteSpace($siteId)) { continue }

        $driveId = ''
        try {
            $drive = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/sites/$siteId/drive?`$select=id"
            if ($null -ne $drive -and $drive.id) { $driveId = [string]$drive.id }
        }
        catch {
            Write-Verbose "Could not retrieve drive for site '$siteId': $($_.Exception.Message)"
            continue
        }
        if ([string]::IsNullOrWhiteSpace($driveId)) { continue }

        foreach ($item in @(Get-SharingReportDriveItems -DriveId $driveId)) {
            $itemId = [string]$item.id
            if ([string]::IsNullOrWhiteSpace($itemId)) { continue }

            $permissionsResponse = $null
            try {
                $permissionsResponse = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/drives/$driveId/items/$itemId/permissions?`$select=id,link,createdBy,createdDateTime,expirationDateTime"
            }
            catch {
                Write-Verbose "Could not retrieve permissions for item '$itemId': $($_.Exception.Message)"
                continue
            }

            foreach ($permission in @($permissionsResponse.value)) {
                if ($null -eq $permission -or $null -eq $permission.link) { continue }
                $row = ConvertTo-SharingReportRow -Site $siteEntry -Item $item -Permission $permission -DriveId $driveId
                if ($null -eq $row) { continue }
                if (Test-SharingReportFilter -Row $row -LinkType $LinkType -Permissions $Permissions -Site $Site -CreatedAfter $CreatedAfter -AnonymousOnly $AnonymousOnly) {
                    $rows.Add($row)
                }
            }
        }
    }

    $offset = ConvertFrom-SharingReportCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-SharingReportCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
