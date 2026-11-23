<#
.SYNOPSIS
    Collects Power BI security and tenant configuration settings.
.DESCRIPTION
    Queries Fabric tenant settings for security-relevant configuration including
    guest access, external sharing, publish to web, sensitivity labels, and service
    principal restrictions. Returns a structured inventory of settings with current
    values and CIS benchmark recommendations.

    Requires the MicrosoftPowerBIMgmt PowerShell module.
    Uses Invoke-PowerBIRestMethod against the Fabric admin API tenant-settings
    endpoint (https://api.fabric.microsoft.com/v1/admin/tenantsettings). The caller
    must be a Fabric administrator (or a service principal allowed to use Fabric
    read-only admin APIs) and hold the Tenant.Read.All delegated scope.
.PARAMETER OutputPath
    Optional path to export results as CSV. If not specified, results are returned to the pipeline.
.EXAMPLE
    PS> . .\Common\Connect-Service.ps1
    PS> Connect-Service -Service PowerBI
    PS> .\PowerBI\Get-PowerBISecurityConfig.ps1

    Displays Power BI security configuration settings.
.EXAMPLE
    PS> .\PowerBI\Get-PowerBISecurityConfig.ps1 -OutputPath '.\powerbi-security-config.csv'

    Exports the security configuration to CSV.
.NOTES
    Author:  Daren9m
    Settings checked are aligned with CIS Microsoft 365 Foundations Benchmark v6.0.1 recommendations.
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath
)

# Stop on errors: API failures should halt this collector rather than produce partial results.
$ErrorActionPreference = 'Stop'

# Verify Power BI connection by attempting to get an access token
try {
    Get-PowerBIAccessToken -ErrorAction Stop -WarningAction SilentlyContinue | Out-Null
}
catch {
    Write-Error "Power BI connection check failed: $($_.Exception.Message). Ensure you have run Connect-PowerBIServiceAccount."
    return
}

# Load shared security-config helpers
$_scriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PSScriptRoot }
. (Join-Path -Path $_scriptDir -ChildPath '..\Common\SecurityConfigHelper.ps1')

$ctx = Initialize-SecurityConfig
$settings = $ctx.Settings

# T-0937: the collector reports its own outcome when the tenant-settings call
# fails, so the orchestrator records Failed (with the reason) instead of Complete
# from the placeholder rows the sentinel writes.
$collectorOutcome = $null


# ─── Retrieve all tenant settings ────────────────────────────────
# Tenant settings are served by the Fabric admin API. The legacy Power BI
# admin/tenantSettings path returns 404 on tenants that only expose the Fabric
# admin surface, so call the documented Fabric endpoint directly.
$fabricTenantSettingsUri = 'https://api.fabric.microsoft.com/v1/admin/tenantsettings'
$script:settingsError = $null
$allSettings = [System.Collections.Generic.List[object]]::new()
try {
    # Fabric pages the response (continuationUri) at a 25 requests/minute limit.
    $nextUri = $fabricTenantSettingsUri
    $pageCount = 0
    while ($nextUri -and $pageCount -lt 100) {
        $pageCount++
        $page = Invoke-PowerBIRestMethod -Url $nextUri -Method Get -WarningAction SilentlyContinue | ConvertFrom-Json

        # Fabric returns { value: [...] } with an 'enabled' flag. Keep the older
        # Power BI shape ({ tenantSettings: [...] } with 'isEnabled') as a
        # fallback so cached/proxied responses still parse.
        $pageSettings = if ($page.PSObject.Properties['value']) { $page.value }
                        elseif ($page.PSObject.Properties['tenantSettings']) { $page.tenantSettings }
                        else { @() }
        foreach ($setting in @($pageSettings)) { $allSettings.Add($setting) }

        $nextUri = if ($page.PSObject.Properties['continuationUri']) { [string]$page.continuationUri } else { '' }
    }
}
catch {
    $errMsg = $_.Exception.Message
    $statusCode = $null
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = $null }
    }
    if (-not $statusCode) {
        if ($errMsg -match '(^|\D)401(\D|$)') { $statusCode = 401 }
        elseif ($errMsg -match '(^|\D)403(\D|$)') { $statusCode = 403 }
        elseif ($errMsg -match '(^|\D)404(\D|$)') { $statusCode = 404 }
    }

    if ($statusCode -eq 401 -or $statusCode -eq 403) {
        # A 401/403 is about who is calling, not where. Name the role and scope.
        $script:settingsError = "Access denied (HTTP $statusCode) calling $fabricTenantSettingsUri -- the calling identity needs the Fabric Administrator role and the Tenant.Read.All delegated scope. Service principals must also be allowed to use Fabric read-only admin APIs. This is a permission or role problem, not a missing endpoint."
    }
    elseif ($statusCode -eq 404) {
        # A 404 is about the endpoint, so do not send the operator to the role page.
        $script:settingsError = "Fabric admin API endpoint not found (HTTP 404) at $fabricTenantSettingsUri -- the endpoint or API version is not available in this cloud or tenant. This is an endpoint or API problem, not a Power BI role problem."
    }
    else {
        $script:settingsError = "Could not retrieve Power BI tenant settings from $fabricTenantSettingsUri`: $errMsg"
    }
    Write-Warning $script:settingsError
    $allSettings = @()

    # Sentinel Warning entry so the report shows a visible failure instead of
    # silently producing Review status for all CIS 9.x checks. It carries a real
    # CheckId (registered in controls/local-extensions.json) so it survives the
    # CheckId filter in Build-SectionHtml and Export-ComplianceMatrix and the CSV,
    # HTML, JSON and XLSX row counts stay aligned (T-0930).
    $sentinelParams = @{
        Category         = 'Power BI'
        Setting          = 'Power BI Tenant Settings'
        CurrentValue     = "Could not verify -- $($script:settingsError)"
        RecommendedValue = 'Verify settings in Fabric Admin Portal > Tenant settings'
        Status           = 'Warning'
        CheckId          = 'POWERBI-COLLECTOR-000'
        Remediation      = 'Fabric Admin Portal > Tenant settings. Confirm the calling identity is a Fabric administrator with the Tenant.Read.All scope (and, for service principals, that Fabric read-only admin APIs are allowed).'
    }
    Add-Setting @sentinelParams

    # T-0937: no tenant settings were retrieved, so the collector Failed. The
    # placeholder rows must not make the summary read Complete.
    $collectorOutcome = [PSCustomObject]@{
        PSTypeName = 'M365Assess.CollectorOutcome'
        Outcome    = 'Failed'
        Reason     = $script:settingsError
    }
}

# Helper: look up a setting by settingName and return its enabled value
function Get-TenantSetting {
    param([string]$SettingName)
    if (-not $allSettings) { return $null }
    $match = @($allSettings | Where-Object { $_.settingName -eq $SettingName }) | Select-Object -First 1
    if (-not $match) { return $null }
    # Fabric uses 'enabled'; the legacy Power BI admin API used 'isEnabled'.
    if ($match.PSObject.Properties['enabled'] -and $null -ne $match.enabled) { return [bool]$match.enabled }
    if ($match.PSObject.Properties['isEnabled'] -and $null -ne $match.isEnabled) { return [bool]$match.isEnabled }
    return $null
}

# ─── CIS 9.1.1: Guest user access restricted ────────────────────
# When AllowGuestLookup is disabled, guest users cannot browse the tenant directory
$guestLookup = Get-TenantSetting -SettingName 'AllowGuestLookup'
$guestStatus = if ($guestLookup -eq $false) { 'Pass' } elseif ($null -eq $guestLookup) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Guest Access'
    Setting          = 'Guest User Access Restricted'
    CurrentValue     = if ($null -eq $guestLookup) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $guestLookup)" }
    RecommendedValue = 'True'
    Status           = $guestStatus
    CheckId          = 'POWERBI-GUEST-001'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Export and sharing > Allow guest users to browse and access Power BI content > Disabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.2: External user invitations restricted ────────────
$guestInvite = Get-TenantSetting -SettingName 'ElevatedGuestsTenant'
$inviteStatus = if ($guestInvite -eq $false) { 'Pass' } elseif ($null -eq $guestInvite) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Guest Access'
    Setting          = 'External User Invitations Restricted'
    CurrentValue     = if ($null -eq $guestInvite) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $guestInvite)" }
    RecommendedValue = 'True'
    Status           = $inviteStatus
    CheckId          = 'POWERBI-GUEST-002'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Export and sharing > Invite external users to your organization > Disabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.3: Guest access to content restricted ──────────────
$guestContent = Get-TenantSetting -SettingName 'AllowGuestUserToAccessSharedContent'
$contentStatus = if ($guestContent -eq $false) { 'Pass' } elseif ($null -eq $guestContent) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Guest Access'
    Setting          = 'Guest Access to Content Restricted'
    CurrentValue     = if ($null -eq $guestContent) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $guestContent)" }
    RecommendedValue = 'True'
    Status           = $contentStatus
    CheckId          = 'POWERBI-GUEST-003'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Export and sharing > Allow Azure Active Directory guest users to access Power BI > Disabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.4: Publish to web restricted ───────────────────────
$publishToWeb = Get-TenantSetting -SettingName 'WebDashboardsPublishToWebDisabled'
$publishStatus = if ($publishToWeb -eq $true) { 'Pass' } elseif ($null -eq $publishToWeb) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Sharing'
    Setting          = 'Publish to Web Restricted'
    CurrentValue     = if ($null -eq $publishToWeb) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$publishToWeb" }
    RecommendedValue = 'True'
    Status           = $publishStatus
    CheckId          = 'POWERBI-SHARING-001'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Export and sharing > Publish to web > Disabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.5: R and Python visuals disabled ───────────────────
$rPython = Get-TenantSetting -SettingName 'RScriptVisuals'
$rPythonStatus = if ($rPython -eq $false) { 'Pass' } elseif ($null -eq $rPython) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Sharing'
    Setting          = 'R and Python Visuals Disabled'
    CurrentValue     = if ($null -eq $rPython) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $rPython)" }
    RecommendedValue = 'True'
    Status           = $rPythonStatus
    CheckId          = 'POWERBI-SHARING-002'
    Remediation      = 'Power BI Admin Portal > Tenant settings > R and Python visuals > Interact with and share R and Python visuals > Disabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.6: Sensitivity labels enabled ──────────────────────
$sensitivityLabels = Get-TenantSetting -SettingName 'UseSensitivityLabels'
$labelsStatus = if ($sensitivityLabels -eq $true) { 'Pass' } elseif ($null -eq $sensitivityLabels) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Information Protection'
    Setting          = 'Sensitivity Labels Enabled'
    CurrentValue     = if ($null -eq $sensitivityLabels) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$sensitivityLabels" }
    RecommendedValue = 'True'
    Status           = $labelsStatus
    CheckId          = 'POWERBI-INFOPROT-001'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Information protection > Allow users to apply sensitivity labels for content > Enabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.7: Shareable links restricted ──────────────────────
$shareLinks = Get-TenantSetting -SettingName 'ShareLinkToEntireOrg'
$shareStatus = if ($shareLinks -eq $false) { 'Pass' } elseif ($null -eq $shareLinks) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Sharing'
    Setting          = 'Shareable Links Restricted'
    CurrentValue     = if ($null -eq $shareLinks) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $shareLinks)" }
    RecommendedValue = 'True'
    Status           = $shareStatus
    CheckId          = 'POWERBI-SHARING-003'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Export and sharing > Allow shareable links to grant access to everyone in your organization > Disabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.8: External data sharing restricted ────────────────
$extDataSharing = Get-TenantSetting -SettingName 'AllowExternalDataSharingReceiverWorksWithShare'
$extStatus = if ($extDataSharing -eq $false) { 'Pass' } elseif ($null -eq $extDataSharing) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Sharing'
    Setting          = 'External Data Sharing Restricted'
    CurrentValue     = if ($null -eq $extDataSharing) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $extDataSharing)" }
    RecommendedValue = 'True'
    Status           = $extStatus
    CheckId          = 'POWERBI-SHARING-004'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Export and sharing > Allow external data sharing > Disabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.9: Block ResourceKey Authentication ────────────────
$blockResKey = Get-TenantSetting -SettingName 'BlockResourceKeyAuthentication'
$resKeyStatus = if ($blockResKey -eq $true) { 'Pass' } elseif ($null -eq $blockResKey) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Authentication'
    Setting          = 'Block ResourceKey Authentication'
    CurrentValue     = if ($null -eq $blockResKey) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$blockResKey" }
    RecommendedValue = 'True'
    Status           = $resKeyStatus
    CheckId          = 'POWERBI-AUTH-001'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Developer settings > Block ResourceKey Authentication > Enabled'
}
Add-Setting @settingParams

# ─── CIS 9.1.10: Service Principal API access restricted ────────
$spAccess = Get-TenantSetting -SettingName 'ServicePrincipalAccess'
$spStatus = if ($spAccess -eq $false) { 'Pass' } elseif ($null -eq $spAccess) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Authentication'
    Setting          = 'Service Principal API Access Restricted'
    CurrentValue     = if ($null -eq $spAccess) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $spAccess)" }
    RecommendedValue = 'True'
    Status           = $spStatus
    CheckId          = 'POWERBI-AUTH-002'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Developer settings > Allow service principals to use Power BI APIs > Disabled or restricted to specific security groups'
}
Add-Setting @settingParams

# ─── CIS 9.1.11: Service Principal profiles restricted ──────────
$spProfiles = Get-TenantSetting -SettingName 'CreateServicePrincipalProfile'
$spProfileStatus = if ($spProfiles -eq $false) { 'Pass' } elseif ($null -eq $spProfiles) { 'Review' } else { 'Fail' }
$settingParams = @{
    Category         = 'Power BI - Authentication'
    Setting          = 'Service Principal Profiles Restricted'
    CurrentValue     = if ($null -eq $spProfiles) { if ($script:settingsError) { $script:settingsError } else { 'Not found' } } else { "$(-not $spProfiles)" }
    RecommendedValue = 'True'
    Status           = $spProfileStatus
    CheckId          = 'POWERBI-AUTH-003'
    Remediation      = 'Power BI Admin Portal > Tenant settings > Developer settings > Allow service principals to create and use profiles > Disabled'
}
Add-Setting @settingParams

# ─── Output ──────────────────────────────────────────────────────
Export-SecurityConfigReport -Settings $settings -OutputPath $OutputPath -ServiceLabel 'Power BI'

# T-0937: emit the outcome for an in-process run, and write it beside the CSV for
# an isolated child-process run (the orchestrator reads and removes that file).
if ($collectorOutcome) {
    if ($OutputPath) {
        $collectorOutcome | ConvertTo-Json -Compress | Set-Content -LiteralPath "$OutputPath.status.json" -Encoding UTF8
    }
    $collectorOutcome
}
