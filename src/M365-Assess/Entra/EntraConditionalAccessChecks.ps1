# -------------------------------------------------------------------
# Entra ID -- Conditional Access & Device Checks
# Extracted from Get-EntraSecurityConfig.ps1 (#256)
# Runs in shared scope: $settings, $checkIdCounter, Add-Setting, $context
# -------------------------------------------------------------------
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseDeclaredVarsMoreThanAssignments', '')]
param()

# Pagination/retry wrapper (#952) — dot-sourced here so the fragment resolves it
# in every load path (module import, parent collector, isolated test harness).
. (Join-Path -Path $PSScriptRoot -ChildPath '..\Common\Invoke-SafeGraphRequest.ps1')

# ------------------------------------------------------------------
# 11. Conditional Access Policy Count
# ------------------------------------------------------------------
try {
    Write-Verbose "Counting conditional access policies..."
    $caPolicies = Invoke-SafeGraphRequest -Uri '/v1.0/identity/conditionalAccess/policies'
    $policyList = @(if ($caPolicies -and $caPolicies['value']) { $caPolicies['value'] })
    $caCount = $policyList.Count
    $enabledCount = @($policyList | Where-Object { $_['state'] -eq 'enabled' }).Count

    $settingParams = @{
        Category         = 'Conditional Access'
        Setting          = 'Total CA Policies'
        CurrentValue     = "$caCount"
        RecommendedValue = '1+'
        Status           = 'Info'
        CheckId          = 'ENTRA-CA-002'
        Remediation      = 'Informational — review Conditional Access policy coverage for your organization.'
    }
    Add-Setting @settingParams

    $settingParams = @{
        Category           = 'Conditional Access'
        Setting            = 'Enabled CA Policies'
        CurrentValue       = "$enabledCount"
        RecommendedValue   = '1+'
        Status             = $(if ($enabledCount -gt 0) { 'Pass' } else { 'Warning' })
        CheckId            = 'ENTRA-CA-003'
        Remediation        = 'Run: Get-MgIdentityConditionalAccessPolicy | Where-Object {$_.State -eq ''enabled''}. Ensure policies are set to On, not Report-only.'
        # D1 #785 -- structured evidence
        ObservedValue      = [string]$enabledCount
        ExpectedValue      = '>=1'
        EvidenceSource     = '/identity/conditionalAccess/policies'
        CollectionMethod   = 'Direct'
        PermissionRequired = 'Policy.Read.All'
        Confidence         = 1.0
    }
    Add-Setting @settingParams

}
catch {
    Write-Warning "Could not check CA policies: $_"
}

# ------------------------------------------------------------------
# 13. Device Registration Policy (CIS 5.1.4.1, 5.1.4.2, 5.1.4.3)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking device registration policy..."
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/v1.0/policies/deviceRegistrationPolicy'
        ErrorAction = 'Stop'
    }
    $devicePolicy = Invoke-MgGraphRequest @graphParams

    if ($devicePolicy) {
        # CIS 5.1.4.1 -- Device join restricted
        $joinType = $devicePolicy['azureADJoin']['allowedToJoin']['@odata.type']
        $joinRestricted = $joinType -ne '#microsoft.graph.allDeviceRegistrationMembership'
        $settingParams = @{
            Category         = 'Device Management'
            Setting          = 'Microsoft Entra Join Restriction'
            CurrentValue     = $(if ($joinRestricted) { 'Restricted' } else { 'All users allowed' })
            RecommendedValue = 'Restricted to specific users/groups'
            Status           = $(if ($joinRestricted) { 'Pass' } else { 'Fail' })
            CheckId          = 'ENTRA-DEVICE-001'
            Remediation      = 'Entra admin center > Devices > Device settings > Users may join devices to Microsoft Entra > Selected. Restrict to a specific group of authorized users.'
        }
        Add-Setting @settingParams

        # CIS 5.1.4.2 -- Max devices per user
        $maxDevices = $devicePolicy['userDeviceQuota']
        $settingParams = @{
            Category         = 'Device Management'
            Setting          = 'Maximum Devices Per User'
            CurrentValue     = "$maxDevices"
            RecommendedValue = '15 or fewer'
            Status           = $(if ($maxDevices -le 15) { 'Pass' } else { 'Fail' })
            CheckId          = 'ENTRA-DEVICE-002'
            Remediation      = 'Entra admin center > Devices > Device settings > Maximum number of devices per user. Set to 15 or lower.'
        }
        Add-Setting @settingParams

        # CIS 5.1.4.3 -- Global admins not added as local admin on join
        $gaLocalAdmin = $true  # Default assumption
        if ($devicePolicy['azureADJoin']['localAdmins']) {
            $gaLocalAdmin = $devicePolicy['azureADJoin']['localAdmins']['enableGlobalAdmins']
        }
        $settingParams = @{
            Category         = 'Device Management'
            Setting          = 'Global Admins as Local Admin on Join'
            CurrentValue     = $(if ($gaLocalAdmin) { 'Enabled' } else { 'Disabled' })
            RecommendedValue = 'Disabled'
            Status           = $(if (-not $gaLocalAdmin) { 'Pass' } else { 'Fail' })
            CheckId          = 'ENTRA-DEVICE-003'
            Remediation      = 'Entra admin center > Devices > Device settings > Global administrator is added as local administrator on the device during Microsoft Entra join > No.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check device registration policy: $_"
}

# ------------------------------------------------------------------
# 19. Device Registration Extensions (CIS 5.1.4.4, 5.1.4.5, 5.1.4.6)
# ------------------------------------------------------------------
try {
    Write-Verbose "Checking extended device registration settings..."
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/beta/policies/deviceRegistrationPolicy'
        ErrorAction = 'Stop'
    }
    $devicePolicyBeta = Invoke-MgGraphRequest @graphParams

    if ($devicePolicyBeta) {
        # CIS 5.1.4.4 -- "Registering user is added as local administrator on the device
        # during Microsoft Entra join" should be None (T-0951). Graph reports it as the
        # @odata.type of azureADJoin.localAdmins.registeringUsers.
        $localAdminSettings = $devicePolicyBeta['azureADJoin']['localAdmins']
        $registeringUsers = if ($localAdminSettings) { $localAdminSettings['registeringUsers'] } else { $null }
        $membershipType = if ($registeringUsers) { [string]$registeringUsers['@odata.type'] } else { '' }

        $deviceAdminResult = switch -Wildcard ($membershipType) {
            '*noDeviceRegistrationMembership' {
                @{ Value = 'Registering user is local admin: None'; Status = 'Pass' }
            }
            '*enumeratedDeviceRegistrationMembership' {
                $selectedCount = @($registeringUsers['users']).Where({ $_ }).Count + @($registeringUsers['groups']).Where({ $_ }).Count
                @{ Value = "Registering user is local admin: Selected ($selectedCount users/groups)"; Status = 'Review' }
            }
            '*allDeviceRegistrationMembership' {
                @{ Value = 'Registering user is local admin: All'; Status = 'Fail' }
            }
            default {
                @{ Value = 'Registering user local admin setting not returned by Graph'; Status = 'Review' }
            }
        }
        $settingParams = @{
            Category         = 'Device Management'
            Setting          = 'Local Admin Assignment on Entra Join'
            CurrentValue     = $deviceAdminResult.Value
            RecommendedValue = 'None (registering users are not local admins)'
            Status           = $deviceAdminResult.Status
            CheckId          = 'ENTRA-DEVICE-004'
            Remediation      = 'Entra admin center > Devices > Device settings > Local administrator settings > Registering user is added as local administrator on the device during Microsoft Entra join: None.'
        }
        Add-Setting @settingParams

        # CIS 5.1.4.5 -- LAPS enabled
        $lapsEnabled = $false
        if ($devicePolicyBeta['localAdminPassword']) {
            $lapsEnabled = $devicePolicyBeta['localAdminPassword']['isEnabled']
        }
        $settingParams = @{
            Category         = 'Device Management'
            Setting          = 'Local Administrator Password Solution (LAPS)'
            CurrentValue     = $(if ($lapsEnabled) { 'Enabled' } else { 'Disabled' })
            RecommendedValue = 'Enabled'
            Status           = $(if ($lapsEnabled) { 'Pass' } else { 'Fail' })
            CheckId          = 'ENTRA-DEVICE-005'
            Remediation      = 'Entra admin center > Devices > Device settings > Enable Microsoft Entra Local Administrator Password Solution (LAPS) > Yes.'
        }
        Add-Setting @settingParams

        # CIS 5.1.4.6 -- BitLocker recovery key restricted
        # Beta API may expose this via deviceRegistrationPolicy or directorySettings
        $settingParams = @{
            Category         = 'Device Management'
            Setting          = 'BitLocker Recovery Key Restriction'
            CurrentValue     = 'Review -- verify users cannot read own BitLocker keys'
            RecommendedValue = 'Users restricted from recovering BitLocker keys'
            Status           = 'Review'
            CheckId          = 'ENTRA-DEVICE-006'
            Remediation      = 'Entra admin center > Devices > Device settings > Restrict users from recovering the BitLocker key(s) for their owned devices > Yes.'
        }
        Add-Setting @settingParams
    }
}
catch {
    Write-Warning "Could not check extended device registration settings: $_"
}
