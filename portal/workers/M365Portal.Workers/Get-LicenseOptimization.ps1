# Get-LicenseOptimization.ps1 — EPIC-033 Licence Optimization worker (SPEC §3.2, §4.2, §11.1; T-0643).
#
# Read-only Graph reads only: gathers per-user licence assignments, per-user
# activity from the Graph usage reports, assignment errors, and upcoming SKU
# expiries. The assigned-but-inactive classification is done by the BFF domain
# function (license-optimization.ts) against the configurable window; this worker
# only gathers. Results are advisory — nothing here removes a licence.

function Read-LicenseOptimizationJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-LicenseOptimization.
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

    $inactivityDays = 30
    if ($null -ne $json.inactivityDays -and [string]$json.inactivityDays -ne '') {
        $inactivityDays = [int]$json.inactivityDays
    }
    if ($inactivityDays -lt 1) { $inactivityDays = 30 }

    return @{
        TenantId       = [string]$json.tenantId
        InactivityDays = $inactivityDays
    }
}

function Get-LicenseOptimizationReportPeriod {
    <#
    .SYNOPSIS
        Picks the Graph usage-report period that covers the inactivity window.
        Graph accepts only D7/D30/D90/D180, so a larger window needs a larger report
        or users idle longer than the report are wrongly absent from it.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$InactivityDays
    )

    if ($InactivityDays -le 7) { return 'D7' }
    if ($InactivityDays -le 30) { return 'D30' }
    if ($InactivityDays -le 90) { return 'D90' }
    return 'D180'
}

function Import-LicenseOptimizationReportCsv {
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
        return @(Import-Csv -Path $tempFile)
    }
    finally {
        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-LicenseOptimizationReportValue {
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
        $value = $null
        if ($Row -is [System.Collections.IDictionary]) {
            if ($Row.Contains($name)) { $value = $Row[$name] }
        }
        elseif ($Row.PSObject.Properties.Name -contains $name) {
            $value = $Row.$name
        }
        if ($null -ne $value -and [string]$value -ne '') {
            return $value
        }
    }
    return $null
}

function Get-LicenseActivityByUser {
    <#
    .SYNOPSIS
        Reads the Graph per-user activity report and returns a lower-cased
        userPrincipalName/UserId keyed map of last activity dates. The import seam
        is injectable so tests need no live Graph.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Period,

        [scriptblock]$Import = $null
    )

    if (-not $Import) { $Import = ${function:Import-LicenseOptimizationReportCsv} }

    $rows = @(& $Import -Uri "/v1.0/reports/getOffice365ActiveUserDetail(period='$Period')")
    $activity = @{}
    foreach ($row in $rows) {
        $upn = Get-LicenseOptimizationReportValue -Row $row -Names @('User Principal Name', 'userPrincipalName')
        $userId = Get-LicenseOptimizationReportValue -Row $row -Names @('User Id', 'userId', 'Id', 'id')
        $lastActivity = Get-LicenseOptimizationReportValue -Row $row -Names @('Last Activity Date', 'lastActivityDate')

        $key = $null
        if ($null -ne $upn) { $key = ([string]$upn).ToLowerInvariant() }
        elseif ($null -ne $userId) { $key = ([string]$userId).ToLowerInvariant() }
        if ($null -eq $key) { continue }

        $activity[$key] = if ($null -ne $lastActivity) { [string]$lastActivity } else { $null }
    }

    return $activity
}

function Get-LicenseOptimization {
    <#
    .SYNOPSIS
        Gathers licence assignments, per-user activity, assignment errors, and
        upcoming SKU expiries from Graph. Read-only operation.
    .DESCRIPTION
        Reads subscribed SKUs, users with their assigned licences, and the Graph
        per-user activity report for a period covering the window. Emits raw rows;
        the BFF classifies unused/overused/expiring and attaches affected users.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [int]$InactivityDays = 30,

        [Parameter()]
        [scriptblock]$Import = $null,

        [Parameter()]
        [datetime]$ReferenceDate = (Get-Date)
    )

    if ($InactivityDays -lt 1) { $InactivityDays = 30 }

    Write-Verbose "Retrieving subscribed SKUs from Graph..."
    $skuResponse = Invoke-MgGraphRequest -Method GET -Uri '/v1.0/subscribedSkus' -ErrorAction Stop
    $rawSkus = @()
    if ($skuResponse -and $skuResponse['value']) {
        $rawSkus = @($skuResponse['value'])
    }
    elseif ($skuResponse -and $skuResponse.value) {
        $rawSkus = @($skuResponse.value)
    }

    $skuById = @{}
    $expirations = [System.Collections.Generic.List[object]]::new()
    foreach ($sku in $rawSkus) {
        $skuId = if ($sku.skuId) { [string]$sku.skuId } else { [string]$sku.SkuId }
        $skuPartNumber = if ($sku.skuPartNumber) { [string]$sku.skuPartNumber } else { [string]$sku.SkuPartNumber }
        $enabled = if ($sku.prepaidUnits -and $null -ne $sku.prepaidUnits.enabled) { [int]$sku.prepaidUnits.enabled } elseif ($sku.PrepaidUnits -and $null -ne $sku.PrepaidUnits.Enabled) { [int]$sku.PrepaidUnits.Enabled } else { 0 }
        $consumed = if ($null -ne $sku.consumedUnits) { [int]$sku.consumedUnits } elseif ($null -ne $sku.ConsumedUnits) { [int]$sku.ConsumedUnits } else { 0 }
        $capabilityStatus = if ($sku.capabilityStatus) { [string]$sku.capabilityStatus } else { [string]$sku.CapabilityStatus }

        $skuById[$skuId] = [pscustomobject]@{
            skuId            = $skuId
            skuPartNumber    = $skuPartNumber
            enabled          = $enabled
            consumed         = $consumed
            capabilityStatus = $capabilityStatus
        }

        $expirationRaw = $null
        foreach ($name in @('expirationDateTime', 'nextLifecycleDateTime', 'subscriptionExpirationDateTime')) {
            $candidate = $null
            if ($sku -is [System.Collections.IDictionary]) {
                if ($sku.Contains($name)) { $candidate = $sku[$name] }
            }
            elseif ($sku.PSObject.Properties.Name -contains $name) {
                $candidate = $sku.$name
            }
            if ($null -ne $candidate -and [string]$candidate -ne '') {
                $expirationRaw = [string]$candidate
                break
            }
        }
        if ($null -ne $expirationRaw) {
            $parsedExpiry = [datetime]::MinValue
            if ([datetime]::TryParse($expirationRaw, [ref]$parsedExpiry)) {
                if ($parsedExpiry -gt $ReferenceDate) {
                    $expirations.Add([pscustomobject]@{
                        skuId              = $skuId
                        skuPartNumber      = $skuPartNumber
                        expirationDateTime = $parsedExpiry.ToUniversalTime().ToString('o')
                    })
                }
            }
        }
    }

    Write-Verbose "Retrieving licensed users from Graph..."
    $users = [System.Collections.Generic.List[object]]::new()
    $uri = "https://graph.microsoft.com/v1.0/users?`$select=id,displayName,userPrincipalName,assignedLicenses&`$top=999"
    do {
        $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType PSObject -ErrorAction Stop
        foreach ($value in @($page.value)) {
            if ($null -ne $value) { $users.Add($value) }
        }
        $uri = if ($page.'@odata.nextLink') { [string]$page.'@odata.nextLink' } else { $null }
    } while ($uri)

    $period = Get-LicenseOptimizationReportPeriod -InactivityDays $InactivityDays
    $activityByUser = Get-LicenseActivityByUser -Period $period -Import $Import

    $assignments = [System.Collections.Generic.List[object]]::new()
    $assignmentErrors = [System.Collections.Generic.List[object]]::new()

    foreach ($user in $users) {
        $userId = if ($user.id) { [string]$user.id } else { '' }
        $displayName = if ($user.displayName) { [string]$user.displayName } else { '' }
        $upn = if ($user.userPrincipalName) { [string]$user.userPrincipalName } else { '' }

        $lastActivity = $null
        $key = $null
        if ($upn -ne '') { $key = $upn.ToLowerInvariant() }
        elseif ($userId -ne '') { $key = $userId.ToLowerInvariant() }
        if ($null -ne $key -and $activityByUser.ContainsKey($key)) {
            $lastActivity = $activityByUser[$key]
        }

        foreach ($license in @($user.assignedLicenses)) {
            if ($null -eq $license) { continue }
            $skuId = if ($license.skuId) { [string]$license.skuId } else { [string]$license.SkuId }
            $sku = $skuById[$skuId]
            $skuPartNumber = if ($sku) { [string]$sku.skuPartNumber } else { '' }

            $assignments.Add([pscustomobject]@{
                userId            = $userId
                userPrincipalName = $upn
                displayName       = $displayName
                skuId             = $skuId
                skuPartNumber     = $skuPartNumber
                lastActivityDate  = $lastActivity
            })

            $assignmentError = $null
            if ($null -eq $sku) {
                $assignmentError = 'assigned licence is not subscribed in the tenant'
            }
            elseif ($sku.capabilityStatus -and $sku.capabilityStatus -ne 'Enabled') {
                $assignmentError = "licence capability is '$($sku.capabilityStatus)'"
            }
            elseif ($sku.consumed -gt $sku.enabled) {
                $assignmentError = "over-allocated: $($sku.consumed) assigned of $($sku.enabled) enabled"
            }

            if ($null -ne $assignmentError) {
                $assignmentErrors.Add([pscustomobject]@{
                    userId            = $userId
                    userPrincipalName = $upn
                    displayName       = $displayName
                    skuId             = $skuId
                    skuPartNumber     = $skuPartNumber
                    error             = $assignmentError
                })
            }
        }
    }

    return [pscustomobject]@{
        tenantId         = $TenantId
        generatedAt      = $ReferenceDate.ToUniversalTime().ToString('o')
        inactivityDays   = $InactivityDays
        assignments      = @($assignments)
        assignmentErrors = @($assignmentErrors)
        expirations      = @($expirations)
    }
}
