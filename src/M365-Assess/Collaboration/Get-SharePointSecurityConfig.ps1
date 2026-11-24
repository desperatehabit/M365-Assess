<#
.SYNOPSIS
    Collects SharePoint Online and OneDrive security configuration settings for M365 assessment.
.DESCRIPTION
    Queries Microsoft Graph and SharePoint admin settings for security-relevant configuration
    including external sharing levels, default link types, re-sharing controls, sync client
    restrictions, and legacy authentication. Returns a structured inventory of settings with
    current values and CIS benchmark recommendations.

    Requires Microsoft Graph connection with SharePointTenantSettings.Read.All permission.
.PARAMETER OutputPath
    Optional path to export results as CSV. If not specified, results are returned to the pipeline.
.EXAMPLE
    PS> . .\Common\Connect-Service.ps1
    PS> Connect-Service -Service Graph -Scopes 'SharePointTenantSettings.Read.All'
    PS> .\Collaboration\Get-SharePointSecurityConfig.ps1

    Displays SharePoint and OneDrive security configuration settings.
.EXAMPLE
    PS> .\Collaboration\Get-SharePointSecurityConfig.ps1 -OutputPath '.\spo-security-config.csv'

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

# Verify Graph connection
if (-not (Assert-GraphConnection)) { return }

# Load shared security-config helpers
$_scriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PSScriptRoot }
. (Join-Path -Path $_scriptDir -ChildPath '..\Common\SecurityConfigHelper.ps1')

# Resolve a SharePoint tenant setting that the API may expose under more than one
# property name. Returns a hashtable so a present-but-false value is distinguishable
# from an absent property (which must be reported as Review, not Pass or Fail).
function Get-SettingProperty {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Settings,

        [Parameter(Mandatory)]
        [string[]]$Name
    )

    foreach ($candidate in $Name) {
        if ($Settings -is [System.Collections.IDictionary]) {
            if ($Settings.Contains($candidate)) {
                return @{ Found = $true; Name = $candidate; Value = $Settings[$candidate] }
            }
        }
        elseif ($Settings.PSObject.Properties.Name -contains $candidate) {
            return @{ Found = $true; Name = $candidate; Value = $Settings.$candidate }
        }
    }

    return @{ Found = $false; Name = $null; Value = $null }
}

# Initialize-SecurityConfig records the active context; the shared Add-Setting from
# SecurityConfigHelper.ps1 reads it, so no local wrapper is needed (#958).
$ctx = Initialize-SecurityConfig
$settings = $ctx.Settings

# ------------------------------------------------------------------
# Retrieve SharePoint tenant settings
# ------------------------------------------------------------------
$spoSettings = $null
try {
    Write-Verbose "Retrieving SharePoint tenant settings..."
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/v1.0/admin/sharepoint/settings'
        ErrorAction = 'Stop'
    }
    $spoSettings = Invoke-MgGraphRequest @graphParams
}
catch {
    $errMsg = $_.Exception.Message
    if ($errMsg -match '401|403|Unauthorized|Forbidden') {
        Write-Warning "SharePoint settings access denied. Ensure 'SharePointTenantSettings.Read.All' is consented. Add this scope when connecting to Graph."
    }
    else {
        Write-Warning "Could not retrieve SharePoint tenant settings: $errMsg"
    }
}

if (-not $spoSettings) {
    Write-Warning "No SharePoint settings retrieved. Cannot perform security assessment."
    if ($OutputPath) {
        @() | Export-Csv -Path $OutputPath -NoTypeInformation -Encoding UTF8
        Write-Output "Exported empty SPO security config to $OutputPath"
    }
    return
}

# ------------------------------------------------------------------
# Pre-fetch: Site list (for site-level checks)
# ------------------------------------------------------------------
# The Graph site resource does not expose sharingCapability, so it must not be
# requested in $select (Graph rejects unknown select properties, which is why the
# site list previously came back empty). Site sharing is evaluated only when a
# response happens to include the property; otherwise SPO-SITE-001 stays Review.
$sites = @()
$siteListReadSucceeded = $false
try {
    $siteResponse = Invoke-MgGraphRequest -Method GET -Uri '/v1.0/sites?$select=id,displayName,webUrl&$top=100' -ErrorAction Stop
    if ($null -ne $siteResponse -and $siteResponse -is [System.Collections.IDictionary] -and $siteResponse.Contains('value')) {
        $sites = @($siteResponse['value'])
        $siteListReadSucceeded = $true
    }
    elseif ($null -ne $siteResponse -and $siteResponse.PSObject.Properties.Name -contains 'value') {
        $sites = @($siteResponse.value)
        $siteListReadSucceeded = $true
    }
}
catch {
    Write-Verbose "Could not retrieve site list: $($_.Exception.Message)"
}

# ------------------------------------------------------------------
# Pre-fetch: Conditional Access policies (for CA coverage check)
# ------------------------------------------------------------------
# Track whether the read itself succeeded so zero policies can be reported as
# "not covered" rather than "unavailable".
$caPolicies = @()
$caReadSucceeded = $false
try {
    $caResponse = Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -ErrorAction Stop
    if ($null -ne $caResponse -and $caResponse -is [System.Collections.IDictionary] -and $caResponse.Contains('value')) {
        $caPolicies = @($caResponse['value'])
        $caReadSucceeded = $true
    }
    elseif ($null -ne $caResponse -and $caResponse.PSObject.Properties.Name -contains 'value') {
        $caPolicies = @($caResponse.value)
        $caReadSucceeded = $true
    }
}
catch {
    Write-Verbose "Could not retrieve CA policies: $($_.Exception.Message)"
}

# ------------------------------------------------------------------
# 1. External Sharing Level
# ------------------------------------------------------------------
try {
    $sharingCapability = $spoSettings['sharingCapability']

    $sharingDisplay = switch ($sharingCapability) {
        'disabled'                    { 'Disabled (no external sharing)' }
        'externalUserSharingOnly'     { 'External users only (require sign-in)' }
        'externalUserAndGuestSharing' { 'External users and guests (anyone with link)' }
        'existingExternalUserSharingOnly' { 'Existing external users only' }
        default { if ($null -ne $sharingCapability) { $sharingCapability } else { 'Not returned by API' } }
    }

    $sharingStatus = switch ($sharingCapability) {
        'disabled'                    { 'Pass' }
        'existingExternalUserSharingOnly' { 'Pass' }
        'externalUserSharingOnly'     { 'Warning' }
        'externalUserAndGuestSharing' { 'Fail' }
        default { 'Review' }
    }

    $settingParams = @{
        Category         = 'External Sharing'
        Setting          = 'SharePoint External Sharing Level'
        CurrentValue     = $sharingDisplay
        RecommendedValue = 'Existing external users only (or more restrictive)'
        Status           = $sharingStatus
        CheckId          = 'SPO-SHARING-001'
        Remediation      = 'Run: Set-SPOTenant -SharingCapability ExistingExternalUserSharingOnly. SharePoint admin center > Policies > Sharing.'
        Evidence         = [PSCustomObject]@{
            SharingCapability            = $sharingCapability
            SharingDomainRestrictionMode = $spoSettings['sharingDomainRestrictionMode']
        }
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check sharing capability: $_"
}

# ------------------------------------------------------------------
# 2. Resharing by External Users
# ------------------------------------------------------------------
try {
    $resharing = Get-SettingProperty -Settings $spoSettings -Name @('isResharingByExternalUsersEnabled')
    $settingParams = @{
        Category         = 'External Sharing'
        Setting          = 'Resharing by External Users'
        CurrentValue     = if ($resharing.Found -and $null -ne $resharing.Value) { "$($resharing.Value)" } else { 'Not returned by API' }
        RecommendedValue = 'False'
        Status           = if (-not ($resharing.Found -and $null -ne $resharing.Value)) { 'Review' }
                           elseif (-not $resharing.Value) { 'Pass' }
                           else { 'Warning' }
        CheckId          = 'SPO-SHARING-002'
        Remediation      = 'Run: Set-SPOTenant -PreventExternalUsersFromResharing $true. SharePoint admin center > Policies > Sharing.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check resharing: $_"
}

# ------------------------------------------------------------------
# 3. Sharing Domain Restriction Mode
# ------------------------------------------------------------------
try {
    $domainRestriction = $spoSettings['sharingDomainRestrictionMode']

    $restrictDisplay = switch ($domainRestriction) {
        'none'       { 'No restriction' }
        'allowList'  { 'Allow list (specific domains only)' }
        'blockList'  { 'Block list (block specific domains)' }
        default { if ($null -ne $domainRestriction) { $domainRestriction } else { 'Not returned by API' } }
    }

    $restrictStatus = switch ($domainRestriction) {
        'none'       { 'Warning' }
        'allowList'  { 'Pass' }
        'blockList'  { 'Pass' }
        default { 'Review' }
    }

    $settingParams = @{
        Category         = 'External Sharing'
        Setting          = 'Sharing Domain Restriction'
        CurrentValue     = $restrictDisplay
        RecommendedValue = 'Allow or Block list configured'
        Status           = $restrictStatus
        CheckId          = 'SPO-SHARING-003'
        Remediation      = 'Run: Set-SPOTenant -SharingDomainRestrictionMode AllowList -SharingAllowedDomainList "partner.com". SharePoint admin center > Policies > Sharing > Limit sharing by domain.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check domain restriction: $_"
}

# ------------------------------------------------------------------
# 4. Unmanaged Sync Client Restriction
# ------------------------------------------------------------------
try {
    # v1.0 sharepointSettings exposes isUnmanagedSyncAppForTenantRestricted;
    # isUnmanagedSyncClientRestricted is accepted as a fallback for older responses.
    $unmanagedSync = Get-SettingProperty -Settings $spoSettings -Name @(
        'isUnmanagedSyncAppForTenantRestricted',
        'isUnmanagedSyncClientRestricted'
    )
    $unmanagedSyncKnown = $unmanagedSync.Found -and $null -ne $unmanagedSync.Value
    $settingParams = @{
        Category         = 'Sync & Access'
        Setting          = 'Block Sync from Unmanaged Devices'
        CurrentValue     = if ($unmanagedSyncKnown) { "$($unmanagedSync.Value)" } else { 'Not returned by API' }
        RecommendedValue = 'True'
        Status           = if (-not $unmanagedSyncKnown) { 'Review' }
                           elseif ($unmanagedSync.Value) { 'Pass' }
                           else { 'Warning' }
        CheckId          = 'SPO-SYNC-001'
        Remediation      = 'Run: Set-SPOTenantSyncClientRestriction -Enable. SharePoint admin center > Settings > Sync > Allow syncing only on computers joined to specific domains.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check sync client restriction: $_"
}

# ------------------------------------------------------------------
# 5. Mac Sync App
# ------------------------------------------------------------------
try {
    $macSync = Get-SettingProperty -Settings $spoSettings -Name @('isMacSyncAppEnabled')
    $macSyncKnown = $macSync.Found -and $null -ne $macSync.Value
    $settingParams = @{
        Category         = 'Sync & Access'
        Setting          = 'Mac Sync App Enabled'
        CurrentValue     = if ($macSyncKnown) { "$($macSync.Value)" } else { 'Not returned by API' }
        RecommendedValue = 'False'
        Status           = if (-not $macSyncKnown) { 'Review' }
                           elseif ($macSync.Value) { 'Warning' }
                           else { 'Pass' }
        CheckId          = 'SPO-SYNC-002'
        Remediation      = 'SharePoint admin center > Settings > Sync > disable Mac sync app if not required by organizational policy.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check Mac sync: $_"
}

# ------------------------------------------------------------------
# 6. Loop Enabled
# ------------------------------------------------------------------
try {
    $loopEnabledSetting = Get-SettingProperty -Settings $spoSettings -Name @('isLoopEnabled')
    $loopEnabledKnown = $loopEnabledSetting.Found -and $null -ne $loopEnabledSetting.Value
    $settingParams = @{
        Category         = 'Collaboration Features'
        Setting          = 'Loop Components Enabled'
        CurrentValue     = if ($loopEnabledKnown) { "$($loopEnabledSetting.Value)" } else { 'Not returned by API' }
        RecommendedValue = 'Organization-dependent'
        Status           = if (-not $loopEnabledKnown) { 'Review' }
                           elseif ($loopEnabledSetting.Value) { 'Review' }
                           else { 'Pass' }
        CheckId          = 'SPO-LOOP-001'
        Remediation      = 'Review Loop components usage policy. Disable via SharePoint admin center > Settings if not required by organizational policy.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check Loop: $_"
}

# ------------------------------------------------------------------
# 7. OneDrive Loop Sharing Capability
# ------------------------------------------------------------------
try {
    $loopSharing = $spoSettings['oneDriveLoopSharingCapability']

    $loopSharingDisplay = switch ($loopSharing) {
        'disabled'                    { 'Disabled' }
        'externalUserSharingOnly'     { 'External users only' }
        'externalUserAndGuestSharing' { 'External users and guests' }
        'existingExternalUserSharingOnly' { 'Existing external users only' }
        default { if ($null -ne $loopSharing) { $loopSharing } else { 'Not returned by API' } }
    }

    $loopSharingStatus = switch ($loopSharing) {
        'disabled'                        { 'Pass' }
        'existingExternalUserSharingOnly' { 'Pass' }
        'externalUserSharingOnly'         { 'Warning' }
        'externalUserAndGuestSharing'     { 'Warning' }
        default { 'Review' }
    }

    $settingParams = @{
        Category         = 'Collaboration Features'
        Setting          = 'OneDrive Loop Sharing'
        CurrentValue     = $loopSharingDisplay
        RecommendedValue = 'Disabled or existing external users only'
        Status           = $loopSharingStatus
        CheckId          = 'SPO-LOOP-002'
        Remediation      = 'SharePoint admin center > Settings > restrict Loop sharing to internal users or existing guests only.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check Loop sharing: $_"
}

# ------------------------------------------------------------------
# 8. Idle Session Timeout (via Graph beta)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking idle session timeout policy..."
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/v1.0/policies/activityBasedTimeoutPolicies'
        ErrorAction = 'Stop'
    }
    $idlePolicy = Invoke-MgGraphRequest @graphParams
    $idlePolicies = Get-SettingProperty -Settings $idlePolicy -Name @('value')

    if (-not $idlePolicies.Found) {
        throw 'Unexpected activity-based timeout policy response'
    }

    if (@($idlePolicies.Value).Count -gt 0) {
        $settingParams = @{
            Category         = 'Sync & Access'
            Setting          = 'Idle Session Timeout Policy'
            CurrentValue     = 'Configured'
            RecommendedValue = 'Configured'
            Status           = 'Pass'
            CheckId          = 'SPO-SESSION-001'
            Remediation      = 'Run: Set-SPOBrowserIdleSignOut -Enabled $true -SignOutAfter ''01:00:00''. M365 admin center > Settings > Org settings > Idle session timeout.'
        }
        Add-Setting @settingParams
    }
    else {
        $settingParams = @{
            Category         = 'Sync & Access'
            Setting          = 'Idle Session Timeout Policy'
            CurrentValue     = 'Not configured'
            RecommendedValue = 'Configured'
            Status           = 'Warning'
            CheckId          = 'SPO-SESSION-001'
            Remediation      = 'Run: Set-SPOBrowserIdleSignOut -Enabled $true -SignOutAfter ''01:00:00''. M365 admin center > Settings > Org settings > Idle session timeout.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check idle session timeout: $_"
    $settingParams = @{
        Category         = 'Sync & Access'
        Setting          = 'Idle Session Timeout Policy'
        CurrentValue     = 'Could not verify — the activity-based timeout policy API did not return a usable response'
        RecommendedValue = 'Configured'
        Status           = 'Review'
        CheckId          = 'SPO-SESSION-001'
        Remediation      = 'Verify in SharePoint Admin Center. Run: Set-SPOBrowserIdleSignOut -Enabled $true -SignOutAfter ''01:00:00''. M365 admin center > Settings > Org settings > Idle session timeout.'
    }
    Add-Setting @settingParams
}

# ------------------------------------------------------------------
# 9. Default Sharing Link Type (CIS 7.2.7)
# ------------------------------------------------------------------
try {
    $defaultLinkType = $spoSettings['defaultSharingLinkType']

    $linkTypeDisplay = switch ($defaultLinkType) {
        'specificPeople'  { 'Specific people (direct)' }
        'organization'    { 'People in the organization' }
        'anyone'          { 'Anyone with the link' }
        default { if ($defaultLinkType) { $defaultLinkType } else { 'Not available via API' } }
    }

    $linkTypeStatus = switch ($defaultLinkType) {
        'specificPeople'  { 'Pass' }
        'organization'    { 'Review' }
        'anyone'          { 'Fail' }
        default { 'Review' }
    }

    $settingParams = @{
        Category         = 'External Sharing'
        Setting          = 'Default Sharing Link Type'
        CurrentValue     = $linkTypeDisplay
        RecommendedValue = 'Specific people (direct)'
        Status           = $linkTypeStatus
        CheckId          = 'SPO-SHARING-004'
        Remediation      = 'Run: Set-SPOTenant -DefaultSharingLinkType Direct. SharePoint admin center > Policies > Sharing > File and folder links > Default link type > Specific people.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check default sharing link type: $_"
}

# ------------------------------------------------------------------
# 10. Guest Access Expiration (CIS 7.2.9)
# ------------------------------------------------------------------
try {
    $guestExpRequiredSetting = Get-SettingProperty -Settings $spoSettings -Name @('externalUserExpirationRequired')
    $guestExpDaysSetting = Get-SettingProperty -Settings $spoSettings -Name @('externalUserExpireInDays')
    $guestExpRequired = $guestExpRequiredSetting.Value
    $guestExpDays = $guestExpDaysSetting.Value

    if (-not $guestExpRequiredSetting.Found -or $null -eq $guestExpRequired) {
        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Guest Access Expiration'
            CurrentValue     = 'Not returned by API'
            RecommendedValue = 'Enabled (30 days or less)'
            Status           = 'Review'
            CheckId          = 'SPO-SHARING-005'
            Remediation      = 'Run: Set-SPOTenant -ExternalUserExpirationRequired $true -ExternalUserExpireInDays 30. SharePoint admin center > Policies > Sharing > Guest access expiration.'
        }
        Add-Setting @settingParams
    }
    elseif ($guestExpRequired -and $null -eq $guestExpDays) {
        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Guest Access Expiration'
            CurrentValue     = 'Enabled, but expiration days not returned by API'
            RecommendedValue = 'Enabled (30 days or less)'
            Status           = 'Review'
            CheckId          = 'SPO-SHARING-005'
            Remediation      = 'Verify the guest access expiration period in SharePoint admin center > Policies > Sharing > Guest access expiration (30 days or less).'
        }
        Add-Setting @settingParams
    }
    else {
        $expDisplay = if ($guestExpRequired) { "Enabled ($guestExpDays days)" } else { 'Disabled' }
        $expStatus = if ($guestExpRequired -and $guestExpDays -le 30) { 'Pass' }
                     elseif ($guestExpRequired) { 'Warning' }
                     else { 'Fail' }

        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Guest Access Expiration'
            CurrentValue     = $expDisplay
            RecommendedValue = 'Enabled (30 days or less)'
            Status           = $expStatus
            CheckId          = 'SPO-SHARING-005'
            Remediation      = 'Run: Set-SPOTenant -ExternalUserExpirationRequired $true -ExternalUserExpireInDays 30. SharePoint admin center > Policies > Sharing > Guest access expiration.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check guest access expiration: $_"
}

# ------------------------------------------------------------------
# 11. Reauthentication with Verification Code (CIS 7.2.10)
# ------------------------------------------------------------------
try {
    $emailAttestationSetting = Get-SettingProperty -Settings $spoSettings -Name @('emailAttestationRequired')
    $emailAttestDaysSetting = Get-SettingProperty -Settings $spoSettings -Name @('emailAttestationReAuthDays')
    $emailAttestation = $emailAttestationSetting.Value
    $emailAttestDays = $emailAttestDaysSetting.Value

    if (-not $emailAttestationSetting.Found -or $null -eq $emailAttestation) {
        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Reauthentication with Verification Code'
            CurrentValue     = 'Not returned by API'
            RecommendedValue = 'Enabled (30 days or less)'
            Status           = 'Review'
            CheckId          = 'SPO-SHARING-006'
            Remediation      = 'Run: Set-SPOTenant -EmailAttestationRequired $true -EmailAttestationReAuthDays 30. SharePoint admin center > Policies > Sharing > Verification code reauthentication.'
        }
        Add-Setting @settingParams
    }
    elseif ($emailAttestation -and $null -eq $emailAttestDays) {
        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Reauthentication with Verification Code'
            CurrentValue     = 'Enabled, but reauthentication days not returned by API'
            RecommendedValue = 'Enabled (30 days or less)'
            Status           = 'Review'
            CheckId          = 'SPO-SHARING-006'
            Remediation      = 'Verify the verification code reauthentication period in SharePoint admin center > Policies > Sharing (30 days or less).'
        }
        Add-Setting @settingParams
    }
    else {
        $attestDisplay = if ($emailAttestation) { "Enabled ($emailAttestDays days)" } else { 'Disabled' }
        $attestStatus = if ($emailAttestation -and $emailAttestDays -le 30) { 'Pass' }
                        elseif ($emailAttestation) { 'Warning' }
                        else { 'Fail' }

        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Reauthentication with Verification Code'
            CurrentValue     = $attestDisplay
            RecommendedValue = 'Enabled (30 days or less)'
            Status           = $attestStatus
            CheckId          = 'SPO-SHARING-006'
            Remediation      = 'Run: Set-SPOTenant -EmailAttestationRequired $true -EmailAttestationReAuthDays 30. SharePoint admin center > Policies > Sharing > Verification code reauthentication.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check email attestation: $_"
}

# ------------------------------------------------------------------
# 12. Default Link Permission (CIS 7.2.11)
# ------------------------------------------------------------------
try {
    $defaultPerm = $spoSettings['defaultLinkPermission']

    $permDisplay = switch ($defaultPerm) {
        'view' { 'View (read-only)' }
        'edit' { 'Edit' }
        default { if ($defaultPerm) { $defaultPerm } else { 'Not available via API' } }
    }

    $permStatus = switch ($defaultPerm) {
        'view' { 'Pass' }
        'edit' { 'Warning' }
        default { 'Review' }
    }

    $settingParams = @{
        Category         = 'External Sharing'
        Setting          = 'Default Sharing Link Permission'
        CurrentValue     = $permDisplay
        RecommendedValue = 'View (read-only)'
        Status           = $permStatus
        CheckId          = 'SPO-SHARING-007'
        Remediation      = 'Run: Set-SPOTenant -DefaultLinkPermission View. SharePoint admin center > Policies > Sharing > File and folder links > Default permission > View.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check default link permission: $_"
}

# ------------------------------------------------------------------
# 13. Legacy Authentication Protocols (CIS 7.2.1)
# ------------------------------------------------------------------
try {
    # #883: Graph v1.0 /admin/sharepoint/settings uses isLegacyAuthProtocolsEnabled
    # (boolean property names use the 'is' prefix). Without it the lookup returns
    # $null and the check always falls through to a Review with "Not available
    # via API" — this property IS available via the v1.0 endpoint.
    $legacyAuth = $spoSettings['isLegacyAuthProtocolsEnabled']
    if ($null -ne $legacyAuth) {
        $settingParams = @{
            Category         = 'Authentication'
            Setting          = 'Legacy Authentication Protocols'
            CurrentValue     = "$legacyAuth"
            RecommendedValue = 'False'
            Status           = if (-not $legacyAuth) { 'Pass' } else { 'Fail' }
            CheckId          = 'SPO-AUTH-001'
            Remediation      = 'Run: Set-SPOTenant -LegacyAuthProtocolsEnabled $false. SharePoint admin center > Policies > Access control > Apps that do not use modern authentication > Block access.'
        }
        Add-Setting @settingParams
    }
    else {
        $settingParams = @{
            Category         = 'Authentication'
            Setting          = 'Legacy Authentication Protocols'
            CurrentValue     = 'Not available via API'
            RecommendedValue = 'False'
            Status           = 'Review'
            CheckId          = 'SPO-AUTH-001'
            Remediation      = 'Check via SharePoint admin center > Policies > Access control > Apps that do not use modern authentication.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check legacy authentication: $_"
}

# ------------------------------------------------------------------
# B2B Integration (CIS 7.2.2)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking B2B integration for SharePoint/OneDrive..."
    # Check via beta endpoint for B2B integration property
    $betaSpoSettings = $null
    try {
        $graphParams = @{
            Method      = 'GET'
            Uri         = '/beta/admin/sharepoint/settings'
            ErrorAction = 'Stop'
        }
        $betaSpoSettings = Invoke-MgGraphRequest @graphParams
    }
    catch {
        Write-Verbose "Beta SharePoint settings endpoint not available: $_"
    }

    if ($betaSpoSettings) {
        $b2bSetting = Get-SettingProperty -Settings $betaSpoSettings -Name @('isB2BIntegrationEnabled')
        $b2bKnown = $b2bSetting.Found -and $null -ne $b2bSetting.Value
    }
    else {
        $b2bSetting = @{ Found = $false; Name = $null; Value = $null }
        $b2bKnown = $false
    }

    if ($b2bKnown) {
        $b2bEnabled = $b2bSetting.Value
        $settingParams = @{
            Category         = 'Authentication'
            Setting          = 'SharePoint B2B Integration'
            CurrentValue     = "$b2bEnabled"
            RecommendedValue = 'True'
            Status           = if ($b2bEnabled) { 'Pass' } else { 'Fail' }
            CheckId          = 'SPO-B2B-001'
            Remediation      = 'Enable B2B integration in SharePoint admin center > Policies > Sharing > More external sharing settings > Enable integration with Microsoft Entra B2B.'
        }
        Add-Setting @settingParams
    }
    else {
        $settingParams = @{
            Category         = 'Authentication'
            Setting          = 'SharePoint B2B Integration'
            CurrentValue     = 'Could not verify — isB2BIntegrationEnabled is not returned by the Graph API for this tenant'
            RecommendedValue = 'True'
            Status           = 'Review'
            CheckId          = 'SPO-B2B-001'
            Remediation      = 'SharePoint admin center > Policies > Sharing > More external sharing settings > check Enable integration with Microsoft Entra B2B.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check B2B integration: $_"
}

# ------------------------------------------------------------------
# OneDrive Sharing Restriction (CIS 7.2.4)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking OneDrive sharing capability..."
    $odSharingSetting = if ($betaSpoSettings) {
        Get-SettingProperty -Settings $betaSpoSettings -Name @('oneDriveSharingCapability')
    }
    else {
        @{ Found = $false; Name = $null; Value = $null }
    }
    $odSharingKnown = $odSharingSetting.Found -and $null -ne $odSharingSetting.Value

    if ($odSharingKnown) {
        $odSharing = $odSharingSetting.Value

        $odDisplay = switch ($odSharing) {
            'disabled'                    { 'Disabled (no sharing)' }
            'externalUserSharingOnly'     { 'Existing guests only' }
            'externalUserAndGuestSharing' { 'Anyone (most permissive)' }
            'existingExternalUserSharingOnly' { 'Existing guests only' }
            default { $odSharing }
        }

        $odStatus = switch ($odSharing) {
            'disabled'                        { 'Pass' }
            'existingExternalUserSharingOnly' { 'Pass' }
            'externalUserSharingOnly'         { 'Warning' }
            'externalUserAndGuestSharing'     { 'Fail' }
            default { 'Review' }
        }

        $settingParams = @{
            Category         = 'Sharing'
            Setting          = 'OneDrive External Sharing'
            CurrentValue     = $odDisplay
            RecommendedValue = 'Existing guests only or more restrictive'
            Status           = $odStatus
            CheckId          = 'SPO-OD-001'
            Remediation      = 'SharePoint admin center > Policies > Sharing > OneDrive > set to "Existing guests" or more restrictive.'
        }
        Add-Setting @settingParams
    }
    else {
        $settingParams = @{
            Category         = 'Sharing'
            Setting          = 'OneDrive External Sharing'
            CurrentValue     = 'Not available via Graph API'
            RecommendedValue = 'Restricted'
            Status           = 'Review'
            CheckId          = 'SPO-OD-001'
            Remediation      = 'SharePoint admin center > Policies > Sharing > OneDrive > verify sharing level.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check OneDrive sharing: $_"
}

# ------------------------------------------------------------------
# Infected File Download Blocked (CIS 7.3.1)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking infected file download blocking..."
    $blockInfectedSetting = if ($betaSpoSettings) {
        Get-SettingProperty -Settings $betaSpoSettings -Name @('disallowInfectedFileDownload')
    }
    else {
        @{ Found = $false; Name = $null; Value = $null }
    }
    $blockInfectedKnown = $blockInfectedSetting.Found -and $null -ne $blockInfectedSetting.Value

    if ($blockInfectedKnown) {
        $blockInfected = $blockInfectedSetting.Value
        $settingParams = @{
            Category         = 'Malware Protection'
            Setting          = 'Infected File Download Blocked'
            CurrentValue     = "$blockInfected"
            RecommendedValue = 'True'
            Status           = if ($blockInfected) { 'Pass' } else { 'Fail' }
            CheckId          = 'SPO-MALWARE-002'
            Remediation      = 'Run: Set-SPOTenant -DisallowInfectedFileDownload $true. SharePoint admin center > Policies > Malware protection.'
        }
        Add-Setting @settingParams
    }
    else {
        $settingParams = @{
            Category         = 'Malware Protection'
            Setting          = 'Infected File Download Blocked'
            CurrentValue     = 'Could not verify — disallowInfectedFileDownload is not returned by the Graph API for this tenant'
            RecommendedValue = 'True'
            Status           = 'Review'
            CheckId          = 'SPO-MALWARE-002'
            Remediation      = 'Connect via SharePoint Online Management Shell: Get-SPOTenant | Select DisallowInfectedFileDownload. Set to $true if not already.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check infected file download setting: $_"
}

# ------------------------------------------------------------------
# External Sharing Restricted by Security Group (CIS 7.2.8)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking external sharing security group restriction..."
    # Security group sharing restriction is not exposed via Graph API — report Review
    $settingParams = @{
        Category         = 'Sharing'
        Setting          = 'External Sharing Restricted by Security Group'
        CurrentValue     = 'Could not verify — Graph API does not expose this setting'
        RecommendedValue = 'Enabled (specific security groups only)'
        Status           = 'Review'
        CheckId          = 'SPO-SHARING-008'
        Remediation      = 'Verify in SharePoint Admin Center or use Get-SPOTenant. SharePoint admin center > Policies > Sharing > More external sharing settings > "Allow only users in specific security groups to share externally".'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check external sharing security group restriction: $_"
}

# ------------------------------------------------------------------
# Custom Script Execution on Personal Sites (CIS 7.3.3)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking custom script execution on personal sites..."
    # Custom script settings are not exposed via Graph API
    # They require SPO PowerShell: Get-SPOSite -Identity <OneDrive-URL> | Select DenyAddAndCustomizePages
    $settingParams = @{
        Category         = 'Script Execution'
        Setting          = 'Custom Script on Personal Sites'
        CurrentValue     = 'Requires SPO PowerShell verification'
        RecommendedValue = 'DenyAddAndCustomizePages = Enabled'
        Status           = 'Review'
        CheckId          = 'SPO-SCRIPT-001'
        Remediation      = 'Run: Set-SPOSite -Identity <PersonalSiteUrl> -DenyAddAndCustomizePages 1. SharePoint admin center > Settings > Custom Script > prevent users from running custom script on personal sites.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check custom script on personal sites: $_"
}

# ------------------------------------------------------------------
# Custom Script Execution on Self-Service Sites (CIS 7.3.4)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking custom script execution on self-service created sites..."
    # Custom script settings are not exposed via Graph API
    # They require SPO PowerShell: Get-SPOTenant | Select DenyAddAndCustomizePagesForSitesCreatedByUser
    $settingParams = @{
        Category         = 'Script Execution'
        Setting          = 'Custom Script on Self-Service Sites'
        CurrentValue     = 'Requires SPO PowerShell verification'
        RecommendedValue = 'DenyAddAndCustomizePages = Enabled'
        Status           = 'Review'
        CheckId          = 'SPO-SCRIPT-002'
        Remediation      = 'Run: Set-SPOTenant -DenyAddAndCustomizePagesForSitesCreatedByUser 1. SharePoint admin center > Settings > Custom Script > prevent users from running custom script on self-service created sites.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check custom script on self-service sites: $_"
}

# --- Site & Access Checks (#382) ---

# ------------------------------------------------------------------
# SPO-SITE-001: Site sharing level within tenant policy
# ------------------------------------------------------------------
try {
    if (-not $siteListReadSucceeded -or $sites.Count -eq 0) {
        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Site Sharing Level vs Tenant Policy'
            CurrentValue     = 'Could not retrieve a usable site list (Sites.Read.All required); site-level sharing cannot be read'
            RecommendedValue = 'All sites at or below tenant sharing level'
            Status           = 'Review'
            CheckId          = 'SPO-SITE-001'
            Remediation      = 'Ensure Sites.Read.All is consented, then review site sharing levels in SharePoint admin center > Active sites.'
        }
        Add-Setting @settingParams
    }
    else {
        # The Graph site resource does not normally expose sharingCapability, so
        # only evaluate sites whose response actually carries the property. Never
        # Pass when the property is absent.
        $sitesWithSharing = @($sites | Where-Object {
            $siteSharing = Get-SettingProperty -Settings $_ -Name @('sharingCapability')
            $siteSharing.Found -and $null -ne $siteSharing.Value
        })

        if ($sitesWithSharing.Count -eq 0) {
            $settingParams = @{
                Category         = 'External Sharing'
                Setting          = 'Site Sharing Level vs Tenant Policy'
                CurrentValue     = 'The Graph site resource does not return sharingCapability; site-level sharing cannot be verified'
                RecommendedValue = 'All sites at or below tenant sharing level'
                Status           = 'Review'
                CheckId          = 'SPO-SITE-001'
                Remediation      = 'Review site sharing levels in SharePoint admin center > Active sites, or use Get-SPOSite in the SharePoint Online Management Shell.'
            }
            Add-Setting @settingParams
        }
        else {
            # Sharing hierarchy: most to least permissive
            $sharingRank = @{
                'externalUserAndGuestSharing'     = 3
                'externalUserSharingOnly'         = 2
                'existingExternalUserSharingOnly' = 1
                'disabled'                        = 0
            }
            $tenantSharing = Get-SettingProperty -Settings $spoSettings -Name @('sharingCapability')
            $tenantRank = if ($tenantSharing.Found -and $sharingRank.ContainsKey($tenantSharing.Value)) { $sharingRank[$tenantSharing.Value] } else { 0 }

            $violatingSites = $sitesWithSharing | Where-Object {
                $siteRank = $sharingRank[$_.sharingCapability]
                $siteRank -gt $tenantRank
            }

            if ($violatingSites) {
                $siteNames = ($violatingSites | ForEach-Object { $_.displayName }) -join ', '
                $settingParams = @{
                    Category         = 'External Sharing'
                    Setting          = 'Site Sharing Level vs Tenant Policy'
                    CurrentValue     = "Violating sites: $siteNames"
                    RecommendedValue = 'All sites at or below tenant sharing level'
                    Status           = 'Fail'
                    CheckId          = 'SPO-SITE-001'
                    Remediation      = 'Review and restrict site-level sharing in SharePoint admin center > Active sites. Site sharing cannot exceed tenant-level sharing policy.'
                }
            }
            elseif ($sitesWithSharing.Count -lt $sites.Count) {
                $settingParams = @{
                    Category         = 'External Sharing'
                    Setting          = 'Site Sharing Level vs Tenant Policy'
                    CurrentValue     = "sharingCapability returned for $($sitesWithSharing.Count) of $($sites.Count) sites; the rest could not be verified"
                    RecommendedValue = 'All sites at or below tenant sharing level'
                    Status           = 'Review'
                    CheckId          = 'SPO-SITE-001'
                    Remediation      = 'Review the remaining site sharing levels in SharePoint admin center > Active sites.'
                }
            }
            else {
                $settingParams = @{
                    Category         = 'External Sharing'
                    Setting          = 'Site Sharing Level vs Tenant Policy'
                    CurrentValue     = "All $($sites.Count) retrieved sites are within tenant policy (capped at 100)"
                    RecommendedValue = 'All sites at or below tenant sharing level'
                    Status           = 'Pass'
                    CheckId          = 'SPO-SITE-001'
                    Remediation      = 'No action required. Note: only first 100 sites retrieved.'
                }
            }
            Add-Setting @settingParams
        }
    }
}
catch {
    Write-Warning "Could not check site sharing levels: $_"
}

# ------------------------------------------------------------------
# SPO-SITE-002: Sensitive sites have restricted sharing
# ------------------------------------------------------------------
try {
    if (-not $siteListReadSucceeded -or $sites.Count -eq 0) {
        $settingParams = @{
            Category         = 'External Sharing'
            Setting          = 'Sensitive Site External Sharing'
            CurrentValue     = 'Site list unavailable; sensitive-site sharing cannot be verified'
            RecommendedValue = 'Sensitive sites should have restricted sharing'
            Status           = 'Review'
            CheckId          = 'SPO-SITE-002'
            Remediation      = 'Review site sharing manually in SharePoint admin center > Active sites.'
        }
        Add-Setting @settingParams
    }
    else {
        $sensitiveKeywords = @('HR', 'Human Resources', 'Finance', 'Legal', 'Payroll', 'Executive', 'Board', 'Confidential', 'Compliance')
        $sensitiveSites = $sites | Where-Object {
            $displayName = $_.displayName
            $sensitiveKeywords | Where-Object { $displayName -match [regex]::Escape($_) }
        }

        if ($sensitiveSites.Count -eq 0) {
            $settingParams = @{
                Category         = 'External Sharing'
                Setting          = 'Sensitive Site External Sharing'
                CurrentValue     = 'No sensitive-named sites found in first 100 sites'
                RecommendedValue = 'Sensitive sites should have restricted sharing'
                Status           = 'Pass'
                CheckId          = 'SPO-SITE-002'
                Remediation      = 'No action required based on retrieved site list. Verify naming conventions cover all sensitive sites.'
            }
        }
        else {
            $sitesWithSharing = @($sensitiveSites | Where-Object {
                $siteSharing = Get-SettingProperty -Settings $_ -Name @('sharingCapability')
                $siteSharing.Found -and $null -ne $siteSharing.Value
            })

            $exposedSites = $sitesWithSharing | Where-Object {
                $_.sharingCapability -ne 'disabled' -and $_.sharingCapability -ne 'existingExternalUserSharingOnly'
            }

            if ($exposedSites) {
                $exposedNames = ($exposedSites | ForEach-Object { $_.displayName }) -join ', '
                $settingParams = @{
                    Category         = 'External Sharing'
                    Setting          = 'Sensitive Site External Sharing'
                    CurrentValue     = "Sensitive sites with external sharing: $exposedNames"
                    RecommendedValue = 'Sensitive sites should have restricted sharing'
                    Status           = 'Warning'
                    CheckId          = 'SPO-SITE-002'
                    Remediation      = 'Set sharing to "Only people in your organization" or "Existing guests" for sensitive sites. SharePoint admin center > Active sites > select site > Sharing.'
                }
            }
            elseif ($sitesWithSharing.Count -eq 0) {
                $settingParams = @{
                    Category         = 'External Sharing'
                    Setting          = 'Sensitive Site External Sharing'
                    CurrentValue     = 'The Graph site resource does not return sharingCapability; sensitive-site sharing cannot be verified'
                    RecommendedValue = 'Sensitive sites should have restricted sharing'
                    Status           = 'Review'
                    CheckId          = 'SPO-SITE-002'
                    Remediation      = 'Review sharing for sensitive sites in SharePoint admin center > Active sites.'
                }
            }
            elseif ($sitesWithSharing.Count -lt $sensitiveSites.Count) {
                $settingParams = @{
                    Category         = 'External Sharing'
                    Setting          = 'Sensitive Site External Sharing'
                    CurrentValue     = "sharingCapability returned for $($sitesWithSharing.Count) of $($sensitiveSites.Count) sensitive sites; the rest could not be verified"
                    RecommendedValue = 'Sensitive sites should have restricted sharing'
                    Status           = 'Review'
                    CheckId          = 'SPO-SITE-002'
                    Remediation      = 'Review the remaining sensitive site sharing levels in SharePoint admin center > Active sites.'
                }
            }
            else {
                $settingParams = @{
                    Category         = 'External Sharing'
                    Setting          = 'Sensitive Site External Sharing'
                    CurrentValue     = "Found $($sensitiveSites.Count) sensitive-named site(s) — all have restricted sharing"
                    RecommendedValue = 'Sensitive sites should have restricted sharing'
                    Status           = 'Pass'
                    CheckId          = 'SPO-SITE-002'
                    Remediation      = 'No action required.'
                }
            }
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check sensitive site sharing: $_"
}

# ------------------------------------------------------------------
# SPO-SITE-003: Site collection admin count visibility (Info only)
# ------------------------------------------------------------------
try {
    $settingParams = @{
        Category         = 'Access Control'
        Setting          = 'Site Collection Administrator Visibility'
        CurrentValue     = "Retrieved $($sites.Count) sites (capped at 100). Site admin counts require SPO PowerShell: Get-SPOSite | Get-SPOSiteAdministrator"
        RecommendedValue = 'Review per-site administrators periodically'
        Status           = 'Info'
        CheckId          = 'SPO-SITE-003'
        Remediation      = 'Run: Get-SPOSite | ForEach-Object { Get-SPOSiteAdministrator -Site $_.Url } to enumerate site administrators.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not report site admin visibility: $_"
}

# ------------------------------------------------------------------
# SPO-ACCESS-001: Conditional Access policy targets SharePoint
# ------------------------------------------------------------------
try {
    if (-not $caReadSucceeded) {
        $settingParams = @{
            Category         = 'Access Control'
            Setting          = 'Conditional Access Coverage for SharePoint'
            CurrentValue     = 'CA policies unavailable (the policy list could not be read)'
            RecommendedValue = 'Enabled CA policy targeting SharePoint or All Cloud Apps'
            Status           = 'Info'
            CheckId          = 'SPO-ACCESS-001'
            Remediation      = 'Ensure Policy.Read.All permission is consented. Create a CA policy targeting SharePoint Online (00000003-0000-0ff1-ce00-000000000000) or All Cloud Apps.'
        }
        Add-Setting @settingParams
    }
    elseif ($caPolicies.Count -eq 0) {
        # The read succeeded and returned zero policies: SharePoint is not covered.
        # Score it the same way the CA-* checks score "no matching policy" (Fail).
        $settingParams = @{
            Category         = 'Access Control'
            Setting          = 'Conditional Access Coverage for SharePoint'
            CurrentValue     = 'No CA policies exist; SharePoint Online is not covered by Conditional Access'
            RecommendedValue = 'Enabled CA policy targeting SharePoint or All Cloud Apps'
            Status           = 'Fail'
            CheckId          = 'SPO-ACCESS-001'
            Remediation      = 'Create a Conditional Access policy targeting SharePoint Online (app ID: 00000003-0000-0ff1-ce00-000000000000) or All Cloud Apps. Entra admin center > Protection > Conditional Access.'
        }
        Add-Setting @settingParams
    }
    else {
        # SharePoint Online app ID and 'All' placeholder
        $spoAppId = '00000003-0000-0ff1-ce00-000000000000'
        $coveringPolicy = $caPolicies | Where-Object {
            $_.state -eq 'enabled' -and (
                $_.conditions.applications.includeApplications -contains $spoAppId -or
                $_.conditions.applications.includeApplications -contains 'All'
            )
        }

        if ($coveringPolicy) {
            $policyNames = ($coveringPolicy | ForEach-Object { $_.displayName }) -join ', '
            $settingParams = @{
                Category         = 'Access Control'
                Setting          = 'Conditional Access Coverage for SharePoint'
                CurrentValue     = "Covered by: $policyNames"
                RecommendedValue = 'Enabled CA policy targeting SharePoint or All Cloud Apps'
                Status           = 'Pass'
                CheckId          = 'SPO-ACCESS-001'
                Remediation      = 'No action required.'
            }
        }
        else {
            $settingParams = @{
                Category         = 'Access Control'
                Setting          = 'Conditional Access Coverage for SharePoint'
                CurrentValue     = 'No enabled CA policy covers SharePoint Online'
                RecommendedValue = 'Enabled CA policy targeting SharePoint or All Cloud Apps'
                Status           = 'Warning'
                CheckId          = 'SPO-ACCESS-001'
                Remediation      = 'Create a Conditional Access policy targeting SharePoint Online (app ID: 00000003-0000-0ff1-ce00-000000000000) or All Cloud Apps with MFA or device compliance requirements. Entra admin center > Protection > Conditional Access.'
            }
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check CA policy coverage for SharePoint: $_"
}

# ------------------------------------------------------------------
# SPO-ACCESS-002: Unmanaged sync client restriction (enforcement angle)
# ------------------------------------------------------------------
try {
    # v1.0 sharepointSettings exposes isUnmanagedSyncAppForTenantRestricted;
    # isUnmanagedSyncClientRestricted is accepted as a fallback for older responses.
    $unmanagedSyncRestricted = Get-SettingProperty -Settings $spoSettings -Name @(
        'isUnmanagedSyncAppForTenantRestricted',
        'isUnmanagedSyncClientRestricted'
    )
    $unmanagedSyncKnown = $unmanagedSyncRestricted.Found -and $null -ne $unmanagedSyncRestricted.Value
    $settingParams = @{
        Category         = 'Sync & Access'
        Setting          = 'Unmanaged Device Sync Restriction'
        CurrentValue     = if ($unmanagedSyncKnown) { "$($unmanagedSyncRestricted.Value)" } else { 'Not returned by API' }
        RecommendedValue = 'True'
        Status           = if (-not $unmanagedSyncKnown) { 'Review' }
                           elseif ($unmanagedSyncRestricted.Value) { 'Pass' }
                           else { 'Warning' }
        CheckId          = 'SPO-ACCESS-002'
        Remediation      = 'Run: Set-SPOTenantSyncClientRestriction -Enable. Also consider Conditional Access policies with device compliance conditions for defense in depth. SharePoint admin center > Settings > Sync.'
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check unmanaged device sync restriction: $_"
}

# ------------------------------------------------------------------
# SPO-VERSIONING-001: Version history configuration
# ------------------------------------------------------------------
try {
    # Check for any versioning-related properties in tenant settings
    $versionProps = $spoSettings.Keys | Where-Object { $_ -match 'version|majorVersion|limitVersionCount' -or $_ -match 'Version' }

    if ($versionProps) {
        $versionProp = $versionProps | Select-Object -First 1
        $versionValue = $spoSettings[$versionProp]

        if ($null -eq $versionValue -or $versionValue -eq 0) {
            $versionStatus = 'Fail'
            $versionDisplay = "Versioning property '$versionProp' is disabled or zero"
        }
        elseif ($versionValue -ge 100) {
            $versionStatus = 'Pass'
            $versionDisplay = "$versionProp = $versionValue"
        }
        else {
            $versionStatus = 'Warning'
            $versionDisplay = "$versionProp = $versionValue (less than 100 recommended)"
        }

        $settingParams = @{
            Category         = 'Data Protection'
            Setting          = 'Version History Configuration'
            CurrentValue     = $versionDisplay
            RecommendedValue = '100 or more major versions retained'
            Status           = $versionStatus
            CheckId          = 'SPO-VERSIONING-001'
            Remediation      = 'Set version history limits at the library level in SharePoint admin center. Ensure at least 100 major versions are retained for ransomware recovery.'
        }
    }
    else {
        $settingParams = @{
            Category         = 'Data Protection'
            Setting          = 'Version History Configuration'
            CurrentValue     = 'Tenant-level versioning limits not configured via Graph API. Verify per-library settings in SharePoint Admin.'
            RecommendedValue = '100 or more major versions retained'
            Status           = 'Info'
            CheckId          = 'SPO-VERSIONING-001'
            Remediation      = 'Review version history settings per library in SharePoint admin center > Active sites > select site > Pages/Documents library settings.'
        }
    }
    Add-Setting @settingParams
}
catch {
    Write-Warning "Could not check version history configuration: $_"
}

# ------------------------------------------------------------------
# Output
# ------------------------------------------------------------------
Export-SecurityConfigReport -Settings $settings -OutputPath $OutputPath -ServiceLabel 'SharePoint/OneDrive'
