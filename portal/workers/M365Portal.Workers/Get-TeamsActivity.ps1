# Get-TeamsActivity.ps1 — EPIC-026 Teams activity report (SPEC §3.2, §4.2, §6, §9, §11.2; T-0507).
#
# Read-only worker handler: reads Teams usage from the Graph usage reports API and
# falls back to the Teams admin report surface where Graph lacks a metric. Never
# writes or modifies teams. The Graph usage report is the primary source; the Teams
# admin center serves its Teams user activity report through the Graph beta reports
# endpoint, so that endpoint is the fallback surface when the v1.0 report is
# unavailable or carries no usable metric values.

function Read-TeamsActivityJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-TeamsActivity.
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

    $period = 'D7'
    if ($null -ne $json.period -and [string]$json.period -ne '') {
        $period = [string]$json.period
    }

    $startDate = [datetime]::MinValue
    if ($null -ne $json.startDate -and [string]$json.startDate -ne '') {
        $startDate = [datetime][string]$json.startDate
    }

    $endDate = [datetime]::MinValue
    if ($null -ne $json.endDate -and [string]$json.endDate -ne '') {
        $endDate = [datetime][string]$json.endDate
    }

    return @{
        TenantId  = [string]$json.tenantId
        Period    = $period
        StartDate = $startDate
        EndDate   = $endDate
    }
}

function Import-TeamsReportCsv {
    <#
    .SYNOPSIS
        Downloads a Graph usage report CSV and returns its rows. Read-only GET.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Uri
    )

    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputFilePath $tempFile -ErrorAction Stop
        $rows = @(Import-Csv -Path $tempFile)
        return $rows
    }
    finally {
        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-GraphTeamsUsageReport {
    <#
    .SYNOPSIS
        Reads the v1.0 Graph usage reports: per-team activity counts and per-user
        activity detail. The import seam is injectable so tests need no live Graph.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Period,

        [scriptblock]$Import = $null
    )

    if (-not $Import) { $Import = ${function:Import-TeamsReportCsv} }

    $teamRows = @(& $Import -Uri "/v1.0/reports/getTeamsTeamActivityCounts(period='$Period')")
    $userRows = @(& $Import -Uri "/v1.0/reports/getTeamsUserActivityUserDetail(period='$Period')")

    return @{
        Teams = $teamRows
        Users = $userRows
    }
}

function Get-TeamsAdminActivityReport {
    <#
    .SYNOPSIS
        Reads the Teams admin report surface (the report the Teams admin center
        serves) through the Graph beta reports endpoint. Fallback for when the v1.0
        Graph usage report is unavailable or lacks a metric. Each section is read
        independently so one failing endpoint does not block the other.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Period,

        [scriptblock]$Import = $null
    )

    if (-not $Import) { $Import = ${function:Import-TeamsReportCsv} }

    $teamRows = @()
    $userRows = @()
    try {
        $teamRows = @(& $Import -Uri "/beta/reports/getTeamsTeamActivityCounts(period='$Period')")
    }
    catch {
        Write-Verbose "Teams admin team report unavailable: $($_.Exception.Message)"
    }
    try {
        $userRows = @(& $Import -Uri "/beta/reports/getTeamsUserActivityUserDetail(period='$Period')")
    }
    catch {
        Write-Verbose "Teams admin user report unavailable: $($_.Exception.Message)"
    }

    return @{
        Teams = $teamRows
        Users = $userRows
    }
}

function Get-TeamsReportValue {
    <#
    .SYNOPSIS
        Reads the first present, non-empty column among $Names from a report row.
        Graph report column names vary by API version, so each metric lists the
        spellings seen in the wild.
    #>
    [CmdletBinding()]
    param(
        [object]$Row,

        [Parameter(Mandatory)]
        [string[]]$Names
    )

    if ($null -eq $Row) { return $null }
    foreach ($name in $Names) {
        if ($Row.PSObject.Properties.Name -contains $name) {
            $value = $Row.$name
            if ($null -ne $value -and [string]$value -ne '') {
                return $value
            }
        }
    }
    return $null
}

function ConvertTo-TeamsInt {
    param([object]$Value)
    if ($null -eq $Value) { return 0 }
    $parsed = 0
    if ([int]::TryParse([string]$Value, [ref]$parsed)) { return $parsed }
    return 0
}

function Test-TeamsRowCarriesMetrics {
    <#
    .SYNOPSIS
        True when at least one row carries a non-empty value for any of the named
        columns — i.e. the report actually provides the metric.
    #>
    [CmdletBinding()]
    param(
        [object[]]$Rows,

        [Parameter(Mandatory)]
        [string[]]$ColumnNames
    )

    foreach ($row in @($Rows)) {
        foreach ($name in $ColumnNames) {
            if ($null -ne (Get-TeamsReportValue -Row $row -Names @($name))) {
                return $true
            }
        }
    }
    return $false
}

function ConvertTo-TeamsActivityReport {
    <#
    .SYNOPSIS
        Pure mapping from raw Graph/Teams-admin report rows to the normalized
        per-team and per-user activity report. Applies the date window to rows
        that carry an activity date; rows without one are kept.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [string]$Period = 'D7',

        [object[]]$TeamRows = @(),

        [object[]]$UserRows = @(),

        [string]$TeamSource = 'graph',

        [string]$UserSource = 'graph',

        [datetime]$StartDate = [datetime]::MinValue,

        [datetime]$EndDate = [datetime]::MinValue
    )

    $teamChatColumns = @('Team Chat Message Count', 'teamChatMessageCount')
    $privateChatColumns = @('Private Chat Message Count', 'privateChatMessageCount')
    $callColumns = @('Call Count', 'callCount')
    $meetingColumns = @('Meeting Count', 'meetingCount')
    $activeUsersColumns = @('Active Users', 'activeUsers')
    $teamNameColumns = @('Team Name', 'Team', 'Display Name', 'displayName')
    $refreshDateColumns = @('Report Refresh Date', 'reportRefreshDate')

    $teamList = [System.Collections.Generic.List[object]]::new()
    foreach ($row in @($TeamRows)) {
        $refreshValue = Get-TeamsReportValue -Row $row -Names $refreshDateColumns
        if ($null -ne $refreshValue) {
            $refreshDate = [datetime]::MinValue
            if (-not [datetime]::TryParse([string]$refreshValue, [ref]$refreshDate)) { continue }
            if ($StartDate -ne [datetime]::MinValue -and $refreshDate.Date -lt $StartDate.Date) { continue }
            if ($EndDate -ne [datetime]::MinValue -and $refreshDate.Date -gt $EndDate.Date) { continue }
        }

        $teamId = Get-TeamsReportValue -Row $row -Names @('Team Id', 'teamId', 'Id', 'id')
        $displayName = Get-TeamsReportValue -Row $row -Names $teamNameColumns
        $activeUsers = ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $activeUsersColumns)
        $messages = (ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $teamChatColumns)) +
            (ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $privateChatColumns))
        $meetings = ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $meetingColumns)
        $calls = ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $callColumns)

        $teamList.Add([pscustomobject]@{
            teamId           = if ($null -ne $teamId) { [string]$teamId } else { $null }
            displayName      = if ($null -ne $displayName) { [string]$displayName } else { '' }
            activeUsers      = $activeUsers
            messages         = $messages
            meetings         = $meetings
            calls            = $calls
            lastActivityDate = if ($null -ne $refreshValue) { [string]$refreshValue } else { $null }
            source           = $TeamSource
        })
    }

    $userList = [System.Collections.Generic.List[object]]::new()
    foreach ($row in @($UserRows)) {
        $activityValue = Get-TeamsReportValue -Row $row -Names @('Last Activity Date', 'lastActivityDate')
        if ($null -ne $activityValue) {
            $activityDate = [datetime]::MinValue
            if (-not [datetime]::TryParse([string]$activityValue, [ref]$activityDate)) { continue }
            if ($StartDate -ne [datetime]::MinValue -and $activityDate.Date -lt $StartDate.Date) { continue }
            if ($EndDate -ne [datetime]::MinValue -and $activityDate.Date -gt $EndDate.Date) { continue }
        }

        $userId = Get-TeamsReportValue -Row $row -Names @('User Id', 'userId', 'Id', 'id')
        $upn = Get-TeamsReportValue -Row $row -Names @('User Principal Name', 'userPrincipalName')
        $displayName = Get-TeamsReportValue -Row $row -Names @('Display Name', 'displayName')
        $teamId = Get-TeamsReportValue -Row $row -Names @('Team Id', 'teamId', 'Team', 'team')
        $messages = (ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $teamChatColumns)) +
            (ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $privateChatColumns))
        $meetings = ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $meetingColumns)
        $calls = ConvertTo-TeamsInt (Get-TeamsReportValue -Row $row -Names $callColumns)
        $active = ($messages + $meetings + $calls) -gt 0

        $userList.Add([pscustomobject]@{
            userId            = if ($null -ne $userId) { [string]$userId } else { $null }
            displayName       = if ($null -ne $displayName) { [string]$displayName } else { '' }
            userPrincipalName = if ($null -ne $upn) { [string]$upn } else { '' }
            teamId            = if ($null -ne $teamId) { [string]$teamId } else { $null }
            active            = $active
            messages          = $messages
            meetings          = $meetings
            calls             = $calls
            lastActivityDate  = if ($null -ne $activityValue) { [string]$activityValue } else { $null }
            source            = $UserSource
        })
    }

    $sortedTeams = @($teamList | Sort-Object -Property messages -Descending)
    $sortedUsers = @($userList | Sort-Object -Property messages -Descending)

    return [pscustomobject]@{
        tenantId    = $TenantId
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        period      = $Period
        startDate   = if ($StartDate -ne [datetime]::MinValue) { $StartDate.ToString('yyyy-MM-dd') } else { $null }
        endDate     = if ($EndDate -ne [datetime]::MinValue) { $EndDate.ToString('yyyy-MM-dd') } else { $null }
        teams       = $sortedTeams
        users       = $sortedUsers
        sources     = [pscustomobject]@{
            teams = $TeamSource
            users = $UserSource
        }
    }
}

function Get-TeamsActivityReport {
    <#
    .SYNOPSIS
        Builds the Teams activity report: Graph usage reports first, Teams admin
        report as the fallback for any section Graph cannot provide. Read-only.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [string]$Period = 'D7',

        [datetime]$StartDate = [datetime]::MinValue,

        [datetime]$EndDate = [datetime]::MinValue,

        [scriptblock]$Import = $null
    )

    if (-not $Import) { $Import = ${function:Import-TeamsReportCsv} }

    $teamMetricColumns = @('Active Users', 'activeUsers', 'Team Chat Message Count', 'teamChatMessageCount', 'Meeting Count', 'meetingCount')
    $userMetricColumns = @('Team Chat Message Count', 'teamChatMessageCount', 'Meeting Count', 'meetingCount', 'Call Count', 'callCount')

    $graphData = $null
    $graphFailure = $null
    try {
        $graphData = Get-GraphTeamsUsageReport -Period $Period -Import $Import
    }
    catch {
        $graphFailure = $_
    }

    $teamSource = 'graph'
    $userSource = 'graph'
    $teamRows = @()
    $userRows = @()

    if ($null -ne $graphData -and -not $graphFailure) {
        $teamRows = @($graphData.Teams)
        $userRows = @($graphData.Users)
        if (-not (Test-TeamsRowCarriesMetrics -Rows $teamRows -ColumnNames $teamMetricColumns)) {
            $teamSource = 'teams-admin'
        }
        if (-not (Test-TeamsRowCarriesMetrics -Rows $userRows -ColumnNames $userMetricColumns)) {
            $userSource = 'teams-admin'
        }
    }
    else {
        $teamSource = 'teams-admin'
        $userSource = 'teams-admin'
    }

    if ($teamSource -eq 'teams-admin' -or $userSource -eq 'teams-admin') {
        $adminData = Get-TeamsAdminActivityReport -Period $Period -Import $Import
        if ($teamSource -eq 'teams-admin') {
            $teamRows = @($adminData.Teams)
        }
        if ($userSource -eq 'teams-admin') {
            $userRows = @($adminData.Users)
        }
    }

    return ConvertTo-TeamsActivityReport -TenantId $TenantId -Period $Period -TeamRows $teamRows -UserRows $userRows -TeamSource $teamSource -UserSource $userSource -StartDate $StartDate -EndDate $EndDate
}
