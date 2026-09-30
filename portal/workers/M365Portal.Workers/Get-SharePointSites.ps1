# Get-SharePointSites.ps1 — EPIC-025 SharePoint site list (SPEC §3.1, §6, §7; T-0482).
#
# Read-only worker handler: enumerates tenant sites live from Graph (Sites.ReadWrite.All,
# app-only per §7) and maps them to the §3.1 columns — Name/URL, Type (team/communication),
# Owners, Storage used, Last activity, Sensitivity, External sharing — with filters for
# type, sharing, storage %, last activity, and sensitivity, plus cursor pagination.
# Filtering happens here so the BFF never materializes a large tenant's full site list.
# The worker is read-only: only GET requests are issued.

function Read-SharePointSitesJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-SharePointSites.
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
        TenantId       = [string]$json.tenantId
        Type           = if ($json.type) { [string]$json.type } else { '' }
        Sharing        = if ($json.sharing) { [string]$json.sharing } else { '' }
        StoragePercent = if ($null -ne $json.storagePercent -and [string]$json.storagePercent -ne '') { [string]$json.storagePercent } else { '' }
        LastActivity   = if ($json.lastActivity) { [string]$json.lastActivity } else { '' }
        Sensitivity    = if ($json.sensitivity) { [string]$json.sensitivity } else { '' }
        Top            = if ($json.top) { [int]$json.top } else { 100 }
        Cursor         = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-SharePointSitesCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-SharePointSitesCursor {
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

function Test-SharePointSiteIsTeam {
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId
    )

    try {
        $null = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/sites/$SiteId/team"
        return $true
    }
    catch {
        if ($_.Exception.Message -match '404|NotFound|Not Found') {
            return $false
        }
        throw
    }
}

function ConvertTo-SharePointSiteRow {
    param(
        [Parameter(Mandatory)]
        [object]$Site,

        [Parameter(Mandatory)]
        [object]$DriveInfo,

        [Parameter(Mandatory)]
        [bool]$IsTeam
    )

    $owners = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $DriveInfo.owner -and $null -ne $DriveInfo.owner.user) {
        $ownerUser = $DriveInfo.owner.user
        $ownerId = if ($ownerUser.userPrincipalName) { [string]$ownerUser.userPrincipalName } elseif ($ownerUser.email) { [string]$ownerUser.email } else { [string]$ownerUser.displayName }
        if (-not [string]::IsNullOrWhiteSpace($ownerId)) {
            $owners.Add($ownerId)
        }
    }

    $storageUsedMB = $null
    $storageAllocatedMB = $null
    $storageUsedPercent = $null
    if ($null -ne $DriveInfo.quota) {
        if ($null -ne $DriveInfo.quota.used) {
            $storageUsedMB = [math]::Round([double]$DriveInfo.quota.used / 1MB, 2)
        }
        if ($null -ne $DriveInfo.quota.total) {
            $storageAllocatedMB = [math]::Round([double]$DriveInfo.quota.total / 1MB, 2)
        }
        if ($null -ne $DriveInfo.quota.used -and $null -ne $DriveInfo.quota.total -and [double]$DriveInfo.quota.total -gt 0) {
            $storageUsedPercent = [math]::Round(([double]$DriveInfo.quota.used / [double]$DriveInfo.quota.total) * 100, 2)
        }
    }

    $sensitivity = ''
    if ($null -ne $Site.sensitivityLabel -and -not [string]::IsNullOrWhiteSpace([string]$Site.sensitivityLabel)) {
        $sensitivity = [string]$Site.sensitivityLabel
    }

    $sharing = ''
    if ($null -ne $Site.sharingCapability -and -not [string]::IsNullOrWhiteSpace([string]$Site.sharingCapability)) {
        $sharing = [string]$Site.sharingCapability
    }

    $lastActivity = $null
    if ($null -ne $Site.lastModifiedDateTime -and -not [string]::IsNullOrWhiteSpace([string]$Site.lastModifiedDateTime)) {
        $lastActivity = [string]$Site.lastModifiedDateTime
    }

    return [pscustomobject]@{
        id                 = if ($Site.id) { [string]$Site.id } else { '' }
        name               = if ($Site.displayName) { [string]$Site.displayName } else { '' }
        url                = if ($Site.webUrl) { [string]$Site.webUrl } else { '' }
        type               = $(if ($IsTeam) { 'team' } else { 'communication' })
        owners             = @($owners)
        storageUsedMB      = $storageUsedMB
        storageAllocatedMB = $storageAllocatedMB
        storageUsedPercent = $storageUsedPercent
        lastActivity       = $lastActivity
        sensitivity        = $sensitivity
        sharing            = $sharing
    }
}

function Test-SharePointSiteFilter {
    param(
        [object]$Row,
        [string]$Type = '',
        [string]$Sharing = '',
        [string]$StoragePercent = '',
        [string]$LastActivity = '',
        [string]$Sensitivity = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Type)) {
        if ($Row.type.ToLowerInvariant() -ne $Type.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Sharing)) {
        if ($Row.sharing.ToLowerInvariant() -ne $Sharing.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($StoragePercent)) {
        if ($null -eq $Row.storageUsedPercent) { return $false }
        if ($Row.storageUsedPercent -lt [double]$StoragePercent) { return $false }
    }

    if (-not [string]::IsNullOrWhiteSpace($LastActivity)) {
        if ($null -eq $Row.lastActivity) { return $false }
        if ([datetime]$Row.lastActivity -lt [datetime]$LastActivity) { return $false }
    }

    if (-not [string]::IsNullOrWhiteSpace($Sensitivity)) {
        $wanted = $Sensitivity.ToLowerInvariant()
        if ($wanted -eq 'none') {
            if (-not [string]::IsNullOrWhiteSpace([string]$Row.sensitivity)) { return $false }
        }
        elseif ($Row.sensitivity.ToLowerInvariant() -ne $wanted) {
            return $false
        }
    }

    return $true
}

function Get-SharePointSites {
    <#
    .SYNOPSIS
        Lists tenant SharePoint sites live from Graph with the §3.1 columns and filters.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateSet('', 'team', 'communication')]
        [string]$Type = '',

        [Parameter()]
        [string]$Sharing = '',

        [Parameter()]
        [string]$StoragePercent = '',

        [Parameter()]
        [string]$LastActivity = '',

        [Parameter()]
        [string]$Sensitivity = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allRawSites = [System.Collections.Generic.List[object]]::new()
    $uri = "/v1.0/sites/getAllSites?`$select=id,displayName,webUrl,createdDateTime,lastModifiedDateTime,isPersonalSite,sharingCapability,sensitivityLabel&`$top=999"

    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry -and -not [bool]$entry.isPersonalSite) {
                    $allRawSites.Add($entry)
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $allRawSites) {
        $siteId = [string]$entry.id
        $driveInfo = $null
        try {
            $driveInfo = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/sites/$siteId/drive?`$select=quota,owner"
        }
        catch {
            Write-Verbose "Could not retrieve drive info for site '$siteId': $($_.Exception.Message)"
            $driveInfo = @{}
        }
        $isTeam = Test-SharePointSiteIsTeam -SiteId $siteId
        $row = ConvertTo-SharePointSiteRow -Site $entry -DriveInfo $driveInfo -IsTeam $isTeam
        if (Test-SharePointSiteFilter -Row $row -Type $Type -Sharing $Sharing -StoragePercent $StoragePercent -LastActivity $LastActivity -Sensitivity $Sensitivity) {
            $rows.Add($row)
        }
    }

    $offset = ConvertFrom-SharePointSitesCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-SharePointSitesCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
