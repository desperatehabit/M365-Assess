# Get-LicenseReport.ps1 — EPIC-033 Licence Consumption worker (SPEC §3.1, §4.1, §6; T-0642).
#
# Live Graph reads only: queries subscribed SKUs and their assigned units, computes
# enabled/assigned/available/utilization per SKU, and joins pricing from the portal
# database (global seed with per-tenant override). An unpriced SKU reports "no pricing"
# rather than a fabricated zero (SPEC §9). The worker is read-only: only GET requests.

function Read-LicenseReportJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-LicenseReport.
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

    $pricing = @()
    if ($null -ne $json.pricing) { $pricing = @($json.pricing) }

    return @{
        TenantId = [string]$json.tenantId
        Pricing  = $pricing
    }
}

function Get-SkuFriendlyNames {
    $skuFriendlyNames = @{}
    $skuCsvUrl = 'https://download.microsoft.com/download/e/3/e/e3e9faf2-f28b-490a-9ada-c6089a1fc5b0/Product%20names%20and%20service%20plan%20identifiers%20for%20licensing.csv'

    function Import-SkuCsv {
        param([Parameter(Mandatory)][object[]]$CsvRows)
        foreach ($row in $CsvRows) {
            $stringId = $row.String_Id
            $displayName = $row.Product_Display_Name
            if ($stringId -and $displayName -and -not $skuFriendlyNames.ContainsKey($stringId)) {
                $skuFriendlyNames[$stringId] = $displayName
            }
        }
    }

    try {
        Write-Verbose "Downloading SKU friendly-name list from Microsoft..."
        $csvText = (Invoke-WebRequest -Uri $skuCsvUrl -UseBasicParsing -TimeoutSec 10).Content
        Import-SkuCsv -CsvRows ($csvText | ConvertFrom-Csv)
        Write-Verbose "Loaded $($skuFriendlyNames.Count) SKU friendly names from Microsoft"
    }
    catch {
        Write-Verbose "Could not download SKU list ($($_.Exception.Message)). Trying bundled copy."
    }

    if ($skuFriendlyNames.Count -eq 0) {
        $bundledCsv = Join-Path -Path $PSScriptRoot -ChildPath '..\..\src\M365-Assess\assets\sku-friendly-names.csv'
        if (Test-Path -Path $bundledCsv) {
            try {
                Import-SkuCsv -CsvRows (Import-Csv -Path $bundledCsv)
                Write-Verbose "Loaded $($skuFriendlyNames.Count) SKU friendly names from bundled CSV"
            }
            catch {
                Write-Verbose "Could not parse bundled SKU CSV: $($_.Exception.Message)"
            }
        }
    }

    return $skuFriendlyNames
}

function Get-LicenseReport {
    <#
    .SYNOPSIS
        Queries subscribed SKUs from Graph and computes consumption with pricing.
    .DESCRIPTION
        Read-only. Retrieves subscribed SKUs via Graph, calculates enabled/assigned/
        available/utilization per SKU, and joins pricing from the portal database
        (global seed with per-tenant override). Unpriced SKUs report "no pricing".
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [object[]]$Pricing = @()
    )

    $skuFriendlyNames = Get-SkuFriendlyNames

    $pricingBySku = @{}
    foreach ($row in $Pricing) {
        if ($null -eq $row) { continue }
        $pricingSkuId = if ($row.skuId) { [string]$row.skuId } else { [string]$row.SkuId }
        if ($pricingSkuId -and -not $pricingBySku.ContainsKey($pricingSkuId)) {
            $pricingBySku[$pricingSkuId] = $row
        }
    }

    Write-Verbose "Retrieving subscribed SKUs from Graph..."
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/v1.0/subscribedSkus'
        ErrorAction = 'Stop'
    }

    $response = Invoke-MgGraphRequest @graphParams
    $rawSkus = @()
    if ($response -and $response['value']) {
        $rawSkus = @($response['value'])
    }
    elseif ($response -and $response.value) {
        $rawSkus = @($response.value)
    }

    $items = [System.Collections.Generic.List[object]]::new()

    foreach ($sku in $rawSkus) {
        $skuId = if ($sku.skuId) { [string]$sku.skuId } else { [string]$sku.SkuId }
        $skuPartNumber = if ($sku.skuPartNumber) { [string]$sku.skuPartNumber } else { [string]$sku.SkuPartNumber }
        $enabled = if ($sku.prepaidUnits -and $sku.prepaidUnits.enabled) { [int]$sku.prepaidUnits.enabled } elseif ($sku.PrepaidUnits -and $sku.PrepaidUnits.Enabled) { [int]$sku.PrepaidUnits.Enabled } else { 0 }
        $assigned = if ($sku.consumedUnits -ne $null) { [int]$sku.consumedUnits } elseif ($sku.ConsumedUnits -ne $null) { [int]$sku.ConsumedUnits } else { 0 }
        $suspended = if ($sku.prepaidUnits -and $sku.prepaidUnits.suspended) { [int]$sku.prepaidUnits.suspended } elseif ($sku.PrepaidUnits -and $sku.PrepaidUnits.Suspended) { [int]$sku.PrepaidUnits.Suspended } else { 0 }
        $warning = if ($sku.prepaidUnits -and $sku.prepaidUnits.warning) { [int]$sku.prepaidUnits.warning } elseif ($sku.PrepaidUnits -and $sku.PrepaidUnits.Warning) { [int]$sku.PrepaidUnits.Warning } else { 0 }

        $available = $enabled - $assigned
        $utilizationPct = if ($enabled -gt 0) { [Math]::Round(($assigned / $enabled) * 100, 1) } else { 0 }

        $friendlyName = $skuFriendlyNames[$skuPartNumber]
        if (-not $friendlyName) { $friendlyName = $skuPartNumber }

        $monthlyCost = 'no pricing'
        $currency = ''
        $pricing = $pricingBySku[$skuId]
        if ($null -ne $pricing) {
            $unitPrice = $null
            if ($null -ne $pricing.unitPrice) { $unitPrice = [double]$pricing.unitPrice }
            elseif ($null -ne $pricing.UnitPrice) { $unitPrice = [double]$pricing.UnitPrice }
            if ($null -ne $unitPrice) {
                $monthlyCost = [Math]::Round($unitPrice * $assigned, 2)
                if ($pricing.currency) { $currency = [string]$pricing.currency } else { $currency = [string]$pricing.Currency }
            }
        }

        $items.Add([pscustomobject]@{
            skuId           = $skuId
            skuPartNumber   = $skuPartNumber
            license         = $friendlyName
            enabled         = $enabled
            assigned        = $assigned
            available       = $available
            suspended       = $suspended
            warning         = $warning
            utilizationPct  = $utilizationPct
            monthlyCost     = $monthlyCost
            currency        = $currency
        })
    }

    $items = @($items | Sort-Object -Property license)

    return [pscustomobject]@{
        tenantId = $TenantId
        items    = @($items)
    }
}