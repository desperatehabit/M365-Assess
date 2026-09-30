# Get-IntuneApps.ps1 - EPIC-017 Intune app list worker (SPEC section 3.1, section 6, section 11; T-0321).
#
# Read-only. Issues only GET requests via Invoke-MgGraphRequest.
# Views: "catalog"  (deviceAppManagement/mobileApps) - beta lists Win32 and Store apps with
#                   their assignments expanded; the tenant's apps of any other type are
#                   counted in 'unsupported', not dropped.
#        "detected" (deviceManagement/detectedApps)  - Graph discovered apps, read live (section 11.4).
#
# The worker rehydrates the EPIC-001 RunContext from a job envelope JSON file,
# calls Graph, and returns a paged result.

function Read-IntuneAppsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-IntuneApps.
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

    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json

    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    $view = if ($json.view) { [string]$json.view } else { 'catalog' }
    if (@('catalog', 'detected') -notcontains $view) {
        throw "job envelope '$Path' has unknown view '$view'; valid: catalog, detected"
    }

    return @{
        TenantId = [string]$json.tenantId
        View     = $view
        AppType  = if ($json.appType) { [string]$json.appType } else { '' }
        Search   = if ($json.search) { [string]$json.search } else { '' }
        # 'true' / 'false' / '' (no filter); the BFF sends a boolean.
        Assigned = if ($null -ne $json.assigned) { ([string]$json.assigned).ToLowerInvariant() } else { '' }
        Top      = if ($json.top) { [int]$json.top } else { 100 }
        Cursor   = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
}

# Mirrors the BFF registry (portal/bff/src/domain/intune-app-types.ts): Graph OData type -> app type.
$script:AppOdataTypes = @{
    '#microsoft.graph.win32LobApp'                  = 'win32'
    '#microsoft.graph.winGetApp'                    = 'store'
    '#microsoft.graph.microsoftStoreForBusinessApp' = 'store'
    '#microsoft.graph.officeSuiteApp'               = 'office'
    '#microsoft.graph.windowsMicrosoftEdgeApp'      = 'edge'
}
$script:SupportedAppTypes = @('win32', 'store')

function Get-GraphValue {
    # Reads a property from a Graph response that may be a hashtable or a PSCustomObject.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    return $Object.$Name
}

function Get-AllGraphPage {
    <#
    .SYNOPSIS
        GETs a Graph collection and follows @odata.nextLink to the end.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([Parameter(Mandatory)][string]$Uri)

    $items = [System.Collections.Generic.List[object]]::new()
    $next = $Uri
    while ($next) {
        $response = Invoke-MgGraphRequest -Method GET -Uri $next
        foreach ($item in @(Get-GraphValue -Object $response -Name 'value')) { if ($null -ne $item) { $items.Add($item) } }
        $next = Get-GraphValue -Object $response -Name '@odata.nextLink'
    }
    return , $items.ToArray()
}

function ConvertTo-IntuneAppRow {
    <#
    .SYNOPSIS
        Normalises a Graph mobileApp into the portal catalog row shape.
    #>
    param([object]$App)

    $odataType = [string](Get-GraphValue -Object $App -Name '@odata.type')
    $appType = 'other'
    foreach ($key in $script:AppOdataTypes.Keys) {
        if ($key -ieq $odataType) { $appType = $script:AppOdataTypes[$key]; break }
    }
    $platform = if ($appType -eq 'other') { 'unknown' } else { 'windows' }
    $assignments = @(Get-GraphValue -Object $App -Name 'assignments' | Where-Object { $null -ne $_ })
    $publisher = Get-GraphValue -Object $App -Name 'publisher'
    $state = Get-GraphValue -Object $App -Name 'publishingState'
    $modified = Get-GraphValue -Object $App -Name 'lastModifiedDateTime'

    return @{
        id                   = [string](Get-GraphValue -Object $App -Name 'id')
        displayName          = [string](Get-GraphValue -Object $App -Name 'displayName')
        appType              = $appType
        odataType            = $odataType
        platform             = $platform
        publisher            = if ($publisher) { [string]$publisher } else { $null }
        assignedCount        = $assignments.Count
        publishingState      = if ($state) { [string]$state } else { $null }
        lastModifiedDateTime = if ($modified) { [string]$modified } else { $null }
    }
}

function ConvertTo-DetectedAppRow {
    <#
    .SYNOPSIS
        Normalises a Graph detectedApp into the portal detected-apps row shape.
    #>
    param([object]$App)

    $version = Get-GraphValue -Object $App -Name 'version'
    $publisher = Get-GraphValue -Object $App -Name 'publisher'
    $platform = Get-GraphValue -Object $App -Name 'platform'
    $size = Get-GraphValue -Object $App -Name 'sizeInByte'
    $count = Get-GraphValue -Object $App -Name 'deviceCount'

    return @{
        id          = [string](Get-GraphValue -Object $App -Name 'id')
        displayName = [string](Get-GraphValue -Object $App -Name 'displayName')
        version     = if ($version) { [string]$version } else { $null }
        publisher   = if ($publisher) { [string]$publisher } else { $null }
        platform    = if ($platform) { [string]$platform } else { $null }
        deviceCount = if ($null -ne $count) { [int]$count } else { 0 }
        sizeInByte  = if ($null -ne $size) { [long]$size } else { $null }
    }
}

function Select-IntuneAppPage {
    # Applies the offset cursor to an already-filtered row set.
    param([object[]]$Row, [int]$Top, [string]$Cursor)

    $offset = 0
    if ($Cursor -and -not [int]::TryParse($Cursor, [ref]$offset)) {
        throw "cursor '$Cursor' is not valid"
    }
    $pageSize = [Math]::Max(1, $Top)
    return @{
        items      = @($Row | Select-Object -Skip $offset -First $pageSize)
        nextCursor = if ($offset + $pageSize -lt $Row.Count) { [string]($offset + $pageSize) } else { $null }
    }
}

function Get-IntuneApps {
    <#
    .SYNOPSIS
        Lists a tenant's Intune app catalog or its detected apps.
    .PARAMETER TenantId
        Tenant GUID or domain.
    .PARAMETER View
        'catalog' (mobileApps) or 'detected' (discovered apps).
    .PARAMETER AppType
        Catalog only: restrict to one supported type (win32, store).
    .PARAMETER Assigned
        Catalog only: 'true' for assigned apps, 'false' for unassigned.
    .PARAMETER Search
        Optional case-insensitive display-name substring.
    .PARAMETER Top
        Page size (default 100). Paging applies after filtering.
    .PARAMETER Cursor
        Offset cursor from a previous page's nextCursor.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [ValidateSet('catalog', 'detected')]
        [string]$View = 'catalog',

        [string]$AppType = '',

        [ValidateSet('', 'true', 'false')]
        [string]$Assigned = '',

        [string]$Search = '',

        [int]$Top = 100,

        [string]$Cursor = ''
    )

    if ($View -eq 'detected') {
        $rows = @(foreach ($app in (Get-AllGraphPage -Uri '/v1.0/deviceManagement/detectedApps')) {
                ConvertTo-DetectedAppRow -App $app
            })
        if ($Search) {
            $rows = @($rows | Where-Object { ([string]$_.displayName).IndexOf($Search, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
        }
        $page = Select-IntuneAppPage -Row $rows -Top $Top -Cursor $Cursor
        return @{
            tenantId   = $TenantId
            view       = 'detected'
            totalCount = $rows.Count
            items      = $page.items
            nextCursor = $page.nextCursor
        }
    }

    if ($AppType) {
        $AppType = $AppType.ToLowerInvariant()
        if ($script:SupportedAppTypes -notcontains $AppType) {
            return @{
                error      = 'intune.app-type.unsupported'
                message    = "App type '$AppType' is not yet supported in v1"
                statusCode = 501
            }
        }
    }

    $all = @(foreach ($app in (Get-AllGraphPage -Uri '/beta/deviceAppManagement/mobileApps?$expand=assignments')) {
            ConvertTo-IntuneAppRow -App $app
        })

    # Apps the v1 catalog does not list are counted by type, never silently dropped.
    $unsupported = @($all | Where-Object { $script:SupportedAppTypes -notcontains $_.appType } |
            Group-Object -Property { $_.appType } | Sort-Object -Property Name |
            ForEach-Object { @{ appType = $_.Name; count = $_.Count } })

    $rows = foreach ($r in $all) {
        if ($script:SupportedAppTypes -notcontains $r.appType) { continue }
        if ($AppType -and $r.appType -ne $AppType) { continue }
        if ($Assigned -eq 'true' -and $r.assignedCount -le 0) { continue }
        if ($Assigned -eq 'false' -and $r.assignedCount -gt 0) { continue }
        if ($Search -and ([string]$r.displayName).IndexOf($Search, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $r
    }
    $rows = @($rows)
    $page = Select-IntuneAppPage -Row $rows -Top $Top -Cursor $Cursor

    return @{
        tenantId    = $TenantId
        view        = 'catalog'
        totalCount  = $rows.Count
        items       = $page.items
        unsupported = $unsupported
        nextCursor  = $page.nextCursor
    }
}
