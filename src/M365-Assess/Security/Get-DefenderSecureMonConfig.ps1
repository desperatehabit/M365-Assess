<#
.SYNOPSIS
    Evaluates whether Microsoft Secure Score monitoring is active for continuous
    security control oversight.
.DESCRIPTION
    Checks whether the tenant has a current Secure Score being actively updated,
    indicating continuous monitoring of security controls. Verifies the score has
    a recent createdDateTime (within 7 days) and that improvement actions are
    being tracked.

    Requires an active Microsoft Graph connection with SecurityEvents.Read.All
    permission.
.PARAMETER OutputPath
    Optional path to export results as CSV. If not specified, results are returned
    to the pipeline.
.EXAMPLE
    PS> .\Security\Get-DefenderSecureMonConfig.ps1

    Displays secure monitoring evaluation results.
.EXAMPLE
    PS> .\Security\Get-DefenderSecureMonConfig.ps1 -OutputPath '.\defender-securemon.csv'

    Exports the evaluation to CSV.
.NOTES
    Author:  Daren9m
    CMMC:    CA.L2-3.12.3 — Monitor Security Controls on an Ongoing Basis
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$_scriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PSScriptRoot }
. (Join-Path -Path $_scriptDir -ChildPath '..\Common\SecurityConfigHelper.ps1')

$ctx = Initialize-SecurityConfig
$settings = $ctx.Settings


# ------------------------------------------------------------------
# 1. Check Secure Score for active monitoring
# ------------------------------------------------------------------
try {
    Write-Verbose 'Checking Microsoft Secure Score for active monitoring...'
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/v1.0/security/secureScores?$top=5'
        ErrorAction = 'Stop'
    }
    $secureScores = Invoke-MgGraphRequest @graphParams

    $scoreExists = $false
    $isRecent = $false
    $currentDetail = 'No Secure Score data available'

    if ($secureScores -and $secureScores['value'] -and @($secureScores['value']).Count -gt 0) {
        $latestScore = $secureScores['value'][0]
        $scoreExists = $true

        $scoreDate = $latestScore['createdDateTime']
        $currentScore = $latestScore['currentScore']
        $maxScore = $latestScore['maxScore']

        # Check if the score was updated within the last 7 days
        $scoreDateParsed = [datetime]::Parse($scoreDate)
        $daysSinceUpdate = ([datetime]::UtcNow - $scoreDateParsed).Days
        $isRecent = $daysSinceUpdate -le 7

        $percentage = if ($maxScore -gt 0) { [math]::Round(($currentScore / $maxScore) * 100, 1) } else { 0 }
        $currentDetail = "Score: $currentScore/$maxScore ($percentage%), Last updated: $scoreDate ($daysSinceUpdate days ago)"
    }

    $settingParams = @{
        Category         = 'Security Monitoring'
        Setting          = 'Microsoft Secure Score Active Monitoring'
        CurrentValue     = $currentDetail
        RecommendedValue = 'Secure Score updated within the last 7 days'
        Status           = if ($isRecent) { 'Pass' } elseif ($scoreExists) { 'Warning' } else { 'Fail' }
        CheckId          = 'DEFENDER-SECUREMON-001'
        Remediation      = 'Access Microsoft Secure Score at security.microsoft.com/securescore. Review and act on improvement recommendations regularly.'
    }
    Add-Setting @settingParams
}
catch {
    if ($_.Exception.Message -match '403|Forbidden|Authorization') {
        $settingParams = @{
            Category         = 'Security Monitoring'
            Setting          = 'Microsoft Secure Score Active Monitoring'
            CurrentValue     = 'Insufficient permissions'
            RecommendedValue = 'Secure Score updated within the last 7 days'
            Status           = 'Review'
            CheckId          = 'DEFENDER-SECUREMON-001'
            Remediation      = 'Requires SecurityEvents.Read.All permission.'
        }
        Add-Setting @settingParams
    }
    else {
        Write-Warning "Could not check Secure Score monitoring: $_"
    }
}

# ------------------------------------------------------------------
# 2. DEFENDER-CLOUDAPPS-001: Defender for Cloud Apps enabled (CIS 2.4.3)
# ------------------------------------------------------------------
# Graph exposes Defender for Cloud Apps licensing but not its app-connector
# configuration, so a licensed and enabled plan reports Review with the steps
# to confirm the Microsoft 365 connector; no plan, or a disabled one, is Fail.
try {
    Write-Verbose 'Checking Microsoft Defender for Cloud Apps licensing...'
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/v1.0/subscribedSkus'
        ErrorAction = 'Stop'
    }
    $skus = Invoke-MgGraphRequest @graphParams
    $mdcaPlans = @{
        'ADALLOM_S_STANDALONE' = 'Microsoft Defender for Cloud Apps'
        'ADALLOM_S_O365'       = 'Office 365 Cloud App Security'
    }
    $found = @()
    foreach ($sku in @($skus['value'])) {
        if ($null -eq $sku) { continue }
        foreach ($plan in @($sku['servicePlans'])) {
            if ($null -ne $plan -and $mdcaPlans.ContainsKey([string]$plan['servicePlanName'])) {
                $found += [PSCustomObject]@{
                    Plan    = [string]$plan['servicePlanName']
                    Status  = [string]$plan['provisioningStatus']
                    Applies = [string]$plan['appliesTo']
                }
            }
        }
    }
    $enabledFull = @($found | Where-Object { $_.Plan -eq 'ADALLOM_S_STANDALONE' -and $_.Status -eq 'Success' })
    $enabledO365 = @($found | Where-Object { $_.Plan -eq 'ADALLOM_S_O365' -and $_.Status -eq 'Success' })
    $connectorSteps = 'Microsoft Defender portal > Settings > Cloud Apps > Connected apps > App Connectors: confirm Microsoft 365 is connected; under Microsoft Defender for Endpoint integration, confirm it is enabled.'

    if ($enabledFull.Count -gt 0) {
        $currentValue = 'Microsoft Defender for Cloud Apps licensed and enabled; app-connector status is not readable through Graph'
        $status = 'Review'
        $remediation = $connectorSteps
    }
    elseif ($enabledO365.Count -gt 0) {
        $currentValue = 'Only Office 365 Cloud App Security is enabled (a subset of Defender for Cloud Apps)'
        $status = 'Warning'
        $remediation = "License Microsoft Defender for Cloud Apps (Microsoft 365 E5 or E5 Security) for full coverage, then: $connectorSteps"
    }
    elseif ($found.Count -gt 0) {
        $currentValue = "Defender for Cloud Apps licensed but not enabled ($((($found | ForEach-Object { "$($_.Plan)=$($_.Status)" }) | Select-Object -Unique) -join ', '))"
        $status = 'Fail'
        $remediation = "Enable the Defender for Cloud Apps service plan on the license, then: $connectorSteps"
    }
    else {
        $currentValue = 'No Defender for Cloud Apps service plan found'
        $status = 'Fail'
        $remediation = "License Microsoft Defender for Cloud Apps (Microsoft 365 E5 or E5 Security), then: $connectorSteps"
    }

    $settingParams = @{
        Category         = 'Security Monitoring'
        Setting          = 'Microsoft Defender for Cloud Apps Enabled'
        CurrentValue     = $currentValue
        RecommendedValue = 'Defender for Cloud Apps enabled with the Microsoft 365 app connector connected'
        Status           = $status
        CheckId          = 'DEFENDER-CLOUDAPPS-001'
        Remediation      = $remediation
    }
    Add-Setting @settingParams
}
catch {
    $settingParams = @{
        Category         = 'Security Monitoring'
        Setting          = 'Microsoft Defender for Cloud Apps Enabled'
        CurrentValue     = if ($_.Exception.Message -match '403|Forbidden|Authorization') { 'Insufficient permissions' } else { "Error: $($_.Exception.Message)" }
        RecommendedValue = 'Defender for Cloud Apps enabled with the Microsoft 365 app connector connected'
        Status           = 'Review'
        CheckId          = 'DEFENDER-CLOUDAPPS-001'
        Remediation      = 'Requires Organization.Read.All permission to read subscribed SKUs.'
    }
    Add-Setting @settingParams
}

# ------------------------------------------------------------------
# Output results
# ------------------------------------------------------------------
Export-SecurityConfigReport -Settings $settings -OutputPath $OutputPath -ServiceLabel 'Defender Secure Mon'
