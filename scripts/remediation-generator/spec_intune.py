from gen import emit, pslit

DM_SC = ['DeviceManagementConfiguration.ReadWrite.All']
EMPTY = '$null -eq $State -or @($State).Count -eq 0'
ASSIGN = [('AssignToGroupId', "[Parameter(Mandatory, ParameterSetName = 'Group')]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Entra group object IDs to assign the policy to.'),
          ('AssignToAll', "[Parameter(Mandatory, ParameterSetName = 'All')]\n[switch]", 'Assign to all devices (configuration profiles) or all users (compliance policies).')]
EX_ASSIGN = "-AssignToGroupId '00000000-0000-0000-0000-000000000001'"


def intune_policy(cid, *, odata, name, body, desc, test, notes='', params=(), prelude='', compliance=False, example=''):
    collection = 'deviceCompliancePolicies' if compliance else 'deviceConfigurations'
    all_target = 'allLicensedUsersAssignmentTarget' if compliance else 'allDevicesAssignmentTarget'
    assign_key = 'assignments' if not compliance else 'assignments'
    pre = (f"$targets = if ($AssignToAll.IsPresent) {{\n    @(@{{ target = @{{ '@odata.type' = '#microsoft.graph.{all_target}' }} }})\n}}\nelse {{\n"
           f"    @($AssignToGroupId | ForEach-Object {{ @{{ target = @{{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $_ }} }} }})\n}}\n"
           f"$profileBody = {body}\n$profileBody['@odata.type'] = '#microsoft.graph.{odata}'\n$profileBody['displayName'] = $ProfileName\n"
           f"$profileBody['description'] = 'Created by M365-Assess remediation {cid}'")
    if compliance:
        pre += "\n$profileBody['scheduledActionsForRule'] = @(@{ ruleName = 'PasswordRequired'; scheduledActionConfigurations = @(@{ actionType = 'block'; gracePeriodHours = 0; notificationTemplateId = ''; notificationMessageCCList = @() }) })"
    if prelude:
        pre = prelude + '\n' + pre
    ps = [(f"ProfileName = '{name}'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Display name of the Intune policy to create or update.')] + list(params) + ASSIGN
    emit(cid, desc=desc, desired=f'Intune policy "{name}" exists with the required settings and is assigned', services=['Graph'], scopes=DM_SC,
         params=ps, example_args=example or EX_ASSIGN, prelude=pre,
         notes=(notes + '\n' if notes else '') + 'Matched by display name: an existing policy with -ProfileName is updated and re-assigned.',
         steps=[dict(target='"Intune policy $ProfileName"', desired='Exists, configured, assigned',
                     get=f"$escaped = $ProfileName.Replace(\"'\", \"''\")\n@((Invoke-MgGraphRequest -Method GET -Uri \"/beta/deviceManagement/{collection}?`$filter=displayName eq '$escaped'&`$expand=assignments\" -OutputType HashTable)['value']) | Where-Object {{ $_ }} | Select-Object -First 1",
                     test=f"$null -ne $State -and @($State['assignments']).Count -gt 0 -and ({test})",
                     set=(f"$id = if ($null -eq $State) {{\n    (Invoke-MgGraphRequest -Method POST -Uri '/beta/deviceManagement/{collection}' -Body ($profileBody | ConvertTo-Json -Depth 20) -ContentType 'application/json' -OutputType HashTable)['id']\n}}\nelse {{\n"
                          f"    $patch = $profileBody.Clone()\n    $patch.Remove('scheduledActionsForRule')\n    Invoke-MgGraphRequest -Method PATCH -Uri \"/beta/deviceManagement/{collection}/$($State['id'])\" -Body ($patch | ConvertTo-Json -Depth 20) -ContentType 'application/json' | Out-Null\n    $State['id']\n}}\n"
                          f"Invoke-MgGraphRequest -Method POST -Uri \"/beta/deviceManagement/{collection}/$id/assign\" -Body (@{{ {assign_key} = $targets }} | ConvertTo-Json -Depth 10) -ContentType 'application/json' | Out-Null"))])


intune_policy('INTUNE-ENCRYPTION-001', odata='windows10EndpointProtectionConfiguration', name='M365-Assess - BitLocker',
              body="@{\n    bitLockerEncryptDevice                     = $true\n    bitLockerEnableStorageCardEncryptionOnMobile = $false\n    bitLockerSystemDrivePolicy                 = @{\n        encryptionMethod              = 'xtsAes256'\n        startupAuthenticationRequired = $true\n        startupAuthenticationTpmUsage = 'allowed'\n        recoveryOptions               = @{\n            blockDataRecoveryAgent                  = $true\n            recoveryPasswordUsage                   = 'allowed'\n            recoveryKeyUsage                        = 'allowed'\n            enableRecoveryInformationSaveToStore    = $true\n            recoveryInformationToStore              = 'passwordAndKey'\n            enableBitLockerAfterRecoveryInformationToStore = $true\n        }\n    }\n    bitLockerFixedDrivePolicy                  = @{ encryptionMethod = 'xtsAes256'; requireEncryptionForWriteAccess = $false }\n}",
              test="$State['bitLockerEncryptDevice'] -eq $true",
              desc='Creates and assigns an Intune BitLocker profile: encrypt the OS drive with XTS-AES 256, require\nTPM startup, and escrow recovery keys to Entra ID before encrypting.',
              notes='Devices without a TPM 2.0 are reported as errors in the profile status.')
intune_policy('INTUNE-FIPS-001', odata='windows10CustomConfiguration', name='M365-Assess - FIPS algorithm policy',
              body="@{\n    omaSettings = @(@{\n        '@odata.type' = '#microsoft.graph.omaSettingInteger'\n        displayName   = 'AllowFipsAlgorithmPolicy'\n        omaUri        = './Device/Vendor/MSFT/Policy/Config/Cryptography/AllowFipsAlgorithmPolicy'\n        value         = 1\n    })\n}",
              test="@($State['omaSettings'] | Where-Object { \"$($_['omaUri'])\" -match 'Cryptography/AllowFipsAlgorithmPolicy' -and \"$($_['value'])\" -eq '1' }).Count -gt 0",
              desc='Creates and assigns a custom OMA-URI profile that turns on FIPS-validated cryptography\n(AllowFipsAlgorithmPolicy = 1) on Windows devices.',
              notes='FIPS mode can break apps and TLS connections that use non-FIPS algorithms. Pilot first.')
for cid, desc in (('INTUNE-PORTSTORAGE-001', 'Creates and assigns a Windows device restriction profile that blocks removable storage on\nmanaged devices.'),
                  ('INTUNE-REMOVABLEMEDIA-001', 'Creates and assigns a Windows device restriction profile that blocks removable media (USB\nstorage, SD cards).')):
    intune_policy(cid, odata='windows10GeneralConfiguration', name='M365-Assess - Block removable storage',
                  body="@{ storageBlockRemovableStorage = $true }", test="$State['storageBlockRemovableStorage'] -eq $true", desc=desc,
                  notes='Users lose access to USB drives. Use a Device control policy (Defender) instead if you need\napproved-device exceptions.')
intune_policy('INTUNE-APPCONTROL-001', odata='windows10EndpointProtectionConfiguration', name='M365-Assess - Application control',
              params=[("Mode = 'auditComponentsAndStoreApps'", "[Parameter()]\n[ValidateSet('auditComponentsAndStoreApps', 'enforceComponentsAndStoreApps', 'auditComponentsStoreAppsAndSmartlocker', 'enforceComponentsStoreAppsAndSmartlocker')]\n[string]",
                       'Application control mode. Defaults to audit (log only) so you can review blocks first.')],
              body="@{ appLockerApplicationControl = $Mode }", test="$State['appLockerApplicationControl'] -eq $Mode",
              desc='Creates and assigns a Windows Defender Application Control profile allowing only Windows\ncomponents and Store apps (optionally reputable apps through the Intelligent Security Graph).',
              notes='Defaults to audit mode. Review CodeIntegrity events (Event Viewer > Applications and Services\n> Microsoft > Windows > CodeIntegrity) before switching to an enforce mode.')
intune_policy('INTUNE-MOBILECODE-001', odata='windows10CustomConfiguration', name='M365-Assess - PowerShell execution policy',
              params=[("ExecutionPolicy = 'AllSigned'", "[Parameter()]\n[ValidateSet('AllSigned', 'RemoteSigned')]\n[string]", 'PowerShell execution policy to enforce.')],
              body="@{\n    omaSettings = @(@{\n        '@odata.type' = '#microsoft.graph.omaSettingString'\n        displayName   = 'TurnOnScriptExecution'\n        omaUri        = './Device/Vendor/MSFT/Policy/Config/WindowsPowerShell/TurnOnScriptExecution'\n        value         = \"<enabled/><data id=`\"ExecutionPolicy`\" value=`\"$ExecutionPolicy`\"/>\"\n    })\n}",
              test="@($State['omaSettings'] | Where-Object { \"$($_['omaUri'])\" -match 'TurnOnScriptExecution' }).Count -gt 0",
              desc='Creates and assigns a profile that enforces a PowerShell execution policy (AllSigned or\nRemoteSigned) through the Turn on Script Execution policy.',
              notes='Intune PowerShell scripts and remediations still run (the management extension bypasses the\npolicy); unsigned admin scripts run by hand will not.')
intune_policy('INTUNE-SECURITY-001', odata='windows10CompliancePolicy', name='M365-Assess - Windows compliance baseline', compliance=True,
              params=[("MinimumOsVersion = '10.0.19045'", "[Parameter()]\n[ValidatePattern('^\\d+\\.\\d+\\.\\d+(\\.\\d+)?$')]\n[string]", 'Minimum Windows build allowed.')],
              body="@{\n    bitLockerEnabled         = $true\n    secureBootEnabled        = $true\n    codeIntegrityEnabled     = $true\n    storageRequireEncryption = $true\n    osMinimumVersion         = $MinimumOsVersion\n    defenderEnabled          = $true\n    rtpEnabled               = $true\n}",
              test="$State['bitLockerEnabled'] -eq $true -and $State['secureBootEnabled'] -eq $true",
              desc='Creates and assigns a Windows compliance policy requiring BitLocker, Secure Boot, code\nintegrity, Defender with real-time protection, and a minimum OS version.',
              notes='Pair with a Conditional Access policy requiring compliant devices (CA-DEVICE-001). Devices that\nfail are marked non-compliant immediately.')
intune_policy('INTUNE-UPDATE-001', odata='windowsUpdateForBusinessConfiguration', name='M365-Assess - Windows Update ring',
              params=[('QualityDeferralDays = 3', "[Parameter()]\n[ValidateRange(0, 7)]\n[int]", 'Quality update deferral (0-7 days).'),
                      ('FeatureDeferralDays = 30', "[Parameter()]\n[ValidateRange(0, 60)]\n[int]", 'Feature update deferral (0-60 days).')],
              body="@{\n    qualityUpdatesDeferralPeriodInDays = $QualityDeferralDays\n    featureUpdatesDeferralPeriodInDays = $FeatureDeferralDays\n    automaticUpdateMode                = 'autoInstallAndRebootAtMaintenanceTime'\n    installationSchedule               = @{ '@odata.type' = '#microsoft.graph.windowsUpdateActiveHoursInstall'; activeHoursStart = '08:00:00.0000000'; activeHoursEnd = '17:00:00.0000000' }\n    microsoftUpdateServiceAllowed      = $true\n    driversExcluded                    = $false\n    businessReadyUpdatesOnly           = 'userDefined'\n    deadlineForQualityUpdatesInDays    = 3\n    deadlineForFeatureUpdatesInDays    = 7\n    deadlineGracePeriodInDays          = 2\n    userPauseAccess                    = 'disabled'\n}",
              test="[int]$State['qualityUpdatesDeferralPeriodInDays'] -le 7",
              desc='Creates and assigns a Windows Update for Business ring: quality updates within a week, feature\nupdates after a short deferral, with install deadlines.')
VPN_PARAMS = [('ServerAddress', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string]", 'VPN server FQDN or IP.'),
              ('ConnectionType', "[Parameter(Mandatory)]\n[ValidateSet('ikEv2', 'ciscoAnyConnect', 'paloAltoGlobalProtect', 'f5EdgeClient', 'pulseSecure', 'checkPointCapsuleVpn', 'citrix', 'microsoftTunnel', 'automatic')]\n[string]", 'VPN client / protocol.'),
              ("AuthenticationMethod = 'certificate'", "[Parameter()]\n[ValidateSet('certificate', 'usernameAndPassword', 'azureAD', 'derivedCredential')]\n[string]", 'How devices authenticate to the VPN.')]
VPN_BODY = "@{\n    connectionName        = $ProfileName\n    connectionType        = $ConnectionType\n    servers               = @(@{ address = $ServerAddress; description = $ServerAddress; isDefaultServer = $true })\n    authenticationMethod  = $AuthenticationMethod\n    enableSplitTunneling  = $false\n    enableAlwaysOn        = $true\n    rememberUserCredentials = $true\n}"
for cid, desc in (('INTUNE-REMOTEVPN-001', 'Creates and assigns an always-on, full-tunnel Windows VPN profile for remote devices.'),
                  ('INTUNE-VPNCONFIG-001', 'Creates and assigns a Windows VPN profile with split tunneling turned off, so all traffic goes\nthrough the VPN.')):
    intune_policy(cid, odata='windows10VpnConfiguration', name='M365-Assess - Always-on VPN', params=VPN_PARAMS, body=VPN_BODY,
                  test="$State['enableSplitTunneling'] -eq $false -and $State['enableAlwaysOn'] -eq $true", desc=desc,
                  example=f"-ServerAddress 'vpn.contoso.com' -ConnectionType ikEv2 {EX_ASSIGN}",
                  notes='Certificate authentication also needs a SCEP/PKCS certificate profile on the devices. The\nassessment check reads alwaysOn; Graph names the property enableAlwaysOn, so confirm the check\nrecognizes the profile.')
intune_policy('INTUNE-WIFI-001', odata='windowsWifiEnterpriseEAPConfiguration', name='M365-Assess - Corporate Wi-Fi (EAP-TLS)',
              params=[('Ssid', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string]", 'Network SSID.'),
                      ('RadiusServerName', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'RADIUS server certificate names devices should trust.'),
                      ('RootCertificateProfileId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'IDs of Intune trusted certificate profiles holding the RADIUS root CA.'),
                      ('ClientCertificateProfileId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string]", 'ID of the SCEP or PKCS certificate profile devices authenticate with.')],
              body="@{\n    networkName                         = $Ssid\n    ssid                                = $Ssid\n    connectAutomatically                = $true\n    connectWhenNetworkNameIsHidden      = $false\n    wifiSecurityType                    = 'wpa2Enterprise'\n    eapType                             = 'eapTls'\n    trustedServerCertificateNames       = @($RadiusServerName)\n    authenticationMethod                = 'certificate'\n    'rootCertificatesForServerValidation@odata.bind' = @($RootCertificateProfileId | ForEach-Object { \"https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations('$_')\" })\n    'identityCertificateForClientAuthentication@odata.bind' = \"https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations('$ClientCertificateProfileId')\"\n}",
              test="$State['wifiSecurityType'] -eq 'wpa2Enterprise' -and $State['eapType'] -eq 'eapTls'",
              example=f"-Ssid 'CORP' -RadiusServerName 'radius.contoso.com' -RootCertificateProfileId '<id>' -ClientCertificateProfileId '<id>' {EX_ASSIGN}",
              desc='Creates and assigns a Windows Wi-Fi profile using WPA2-Enterprise with EAP-TLS certificate\nauthentication.')

emit('INTUNE-MOBILEENCRYPT-001',
     desc='Requires device encryption in every Android compliance policy, and a passcode (which turns on\niOS data protection) in every iOS compliance policy.',
     desired='All mobile compliance policies require encryption', services=['Graph'], scopes=DM_SC,
     notes='Only existing compliance policies are changed. If you have none, create them first (Intune >\nDevices > Compliance). iOS has no separate encryption setting; data protection is on whenever a\npasscode is set, so the check may still flag iOS policies.',
     steps=[dict(target='Mobile compliance policies without encryption', desired='Encryption required',
                 get="@(@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceCompliancePolicies' -OutputType HashTable)['value']) | Where-Object {\n    $null -ne $_ -and (\n        ($_['@odata.type'] -match 'android' -and $_['storageRequireEncryption'] -ne $true) -or\n        ($_['@odata.type'] -match 'ios' -and $_['passcodeRequired'] -ne $true)\n    )\n} | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; Type = $_['@odata.type']; DisplayName = $_['displayName'] } })",
                 test=EMPTY,
                 set="foreach ($policy in $State) {\n    $patch = if ($policy.Type -match 'android') { @{ '@odata.type' = $policy.Type; storageRequireEncryption = $true } } else { @{ '@odata.type' = $policy.Type; passcodeRequired = $true } }\n    Set-RemediationGraphObject -Uri \"/beta/deviceManagement/deviceCompliancePolicies/$($policy.Id)\" -Body $patch\n}")])

emit('INTUNE-COMPLIANCE-001',
     desc='Marks devices with no compliance policy assigned as Not compliant, and sets the compliance\nvalidity period to 30 days or fewer.',
     desired='secureByDefault = true; deviceComplianceCheckinThresholdDays <= 30', services=['Graph'], scopes=['DeviceManagementServiceConfig.ReadWrite.All'],
     notes='Devices that have no compliance policy become non-compliant and are blocked by any CA policy\nrequiring compliant devices. Assign compliance policies to every platform first.',
     steps=[dict(target='Intune compliance policy settings', desired='No-policy devices non-compliant, threshold <= 30 days',
                 get="Get-RemediationGraphObject -Uri '/beta/deviceManagement/settings'",
                 test="$State['secureByDefault'] -eq $true -and $null -ne $State['deviceComplianceCheckinThresholdDays'] -and [int]$State['deviceComplianceCheckinThresholdDays'] -le 30",
                 set="$days = if ($null -ne $State['deviceComplianceCheckinThresholdDays'] -and [int]$State['deviceComplianceCheckinThresholdDays'] -le 30 -and [int]$State['deviceComplianceCheckinThresholdDays'] -ge 1) { [int]$State['deviceComplianceCheckinThresholdDays'] } else { 30 }\nSet-RemediationGraphObject -Uri '/beta/deviceManagement' -Body @{ settings = @{ secureByDefault = $true; deviceComplianceCheckinThresholdDays = $days } }")])

PLATS = "@('iosRestriction', 'androidRestriction', 'androidForWorkRestriction', 'windowsRestriction', 'macOSRestriction')"
emit('INTUNE-ENROLL-001',
     desc='Blocks enrollment of personally owned devices in the default device platform restriction.',
     desired='personalDeviceEnrollmentBlocked = true for each platform', services=['Graph'], scopes=['DeviceManagementServiceConfig.ReadWrite.All'],
     params=[(f"Platform = {PLATS}", "[Parameter()]\n[ValidateSet('iosRestriction', 'androidRestriction', 'androidForWorkRestriction', 'windowsRestriction', 'macOSRestriction')]\n[string[]]",
              'Platforms to block personal enrollment for. Defaults to all.')],
     notes='Corporate devices must be identified (Autopilot, Apple ADE, Android Enterprise corporate, or\ncorporate identifiers) or they will also be blocked. Tenants using per-platform restriction\npolicies need those edited instead.',
     steps=[dict(target='Default device platform restriction', desired='Personal enrollment blocked',
                 get="@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceEnrollmentConfigurations' -OutputType HashTable)['value']) |\n    Where-Object { $null -ne $_ -and $_['@odata.type'] -eq '#microsoft.graph.deviceEnrollmentPlatformRestrictionsConfiguration' } | Select-Object -First 1",
                 test="$null -ne $State -and @($Platform | Where-Object { $State[$_] -and $State[$_]['personalDeviceEnrollmentBlocked'] -ne $true }).Count -eq 0",
                 set="$patch = @{ '@odata.type' = '#microsoft.graph.deviceEnrollmentPlatformRestrictionsConfiguration' }\nforeach ($p in $Platform) {\n    if ($State[$p]) {\n        $r = @{}\n        foreach ($k in $State[$p].Keys) { $r[$k] = $State[$p][$k] }\n        $r['personalDeviceEnrollmentBlocked'] = $true\n        $patch[$p] = $r\n    }\n}\nSet-RemediationGraphObject -Uri \"/beta/deviceManagement/deviceEnrollmentConfigurations/$($State['id'])\" -Body $patch")])

emit('INTUNE-ENROLLMENT-001',
     desc='Sets the default device limit restriction (maximum devices each user can enroll).',
     desired='Default enrollment limit <= -Limit', services=['Graph'], scopes=['DeviceManagementServiceConfig.ReadWrite.All'],
     params=[('Limit = 5', "[Parameter()]\n[ValidateRange(1, 15)]\n[int]", 'Maximum devices per user. An existing lower limit is kept.')],
     steps=[dict(target='Default device limit restriction', desired='"$Limit devices or fewer"',
                 get="@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceEnrollmentConfigurations' -OutputType HashTable)['value']) |\n    Where-Object { $null -ne $_ -and $_['@odata.type'] -eq '#microsoft.graph.deviceEnrollmentLimitConfiguration' } | Sort-Object -Property { [int]$_['priority'] } -Descending | Select-Object -First 1",
                 test="$null -ne $State -and [int]$State['limit'] -le $Limit",
                 set="Set-RemediationGraphObject -Uri \"/beta/deviceManagement/deviceEnrollmentConfigurations/$($State['id'])\" -Body @{ '@odata.type' = '#microsoft.graph.deviceEnrollmentLimitConfiguration'; limit = $Limit }")])

emit('INTUNE-INVENTORY-001',
     desc='Creates the Intune device categories you name, so devices can be grouped in the inventory.',
     desired='Each -CategoryName exists', services=['Graph'], scopes=['DeviceManagementManagedDevices.ReadWrite.All'],
     params=[('CategoryName', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", "Category names, e.g. 'Corporate laptop', 'Kiosk', 'Shared'.")],
     example_args="-CategoryName 'Corporate laptop', 'Kiosk'",
     notes='Devices also need to be enrolled; users pick a category on enrollment, or you can set it on\nthe device. Dynamic groups can use deviceCategory.',
     steps=[dict(target='Intune device categories', desired='Created',
                 get="$existing = @(@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceCategories' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object { $_['displayName'] })\n@($CategoryName | Where-Object { $existing -notcontains $_ })",
                 test=EMPTY,
                 set="foreach ($name in $State) { Set-RemediationGraphObject -Uri '/beta/deviceManagement/deviceCategories' -Method POST -Body @{ displayName = $name; description = $name } }")])

emit('INTUNE-AUTODISC-001',
     desc='Turns on Windows automatic MDM enrollment into Intune for all users, or the groups you name\n(Entra ID > Mobility (MDM and WIP) > Microsoft Intune > MDM user scope).',
     desired='Intune MDM user scope = All or Selected', services=['Graph'], scopes=['Policy.ReadWrite.MobilityManagement'],
     params=[('GroupId', "[Parameter()]\n[string[]]", 'Groups to scope enrollment to. Omit for All users.')],
     notes='Uses the Graph beta mobileDeviceManagementPolicies endpoint (Intune app ID\n0000000a-0000-0000-c000-000000000000). The assessment reads deviceEnrollmentConfigurations,\nso confirm the check recognizes the change.',
     prelude="$intuneMdm = '/beta/policies/mobileDeviceManagementPolicies/0000000a-0000-0000-c000-000000000000'\n$wanted = if (@($GroupId | Where-Object { $_ }).Count -gt 0) { 'selected' } else { 'all' }",
     steps=[dict(target='Intune MDM user scope', desired='"$wanted"',
                 get='Get-RemediationGraphObject -Uri $intuneMdm',
                 test="$State['appliesTo'] -eq $wanted",
                 set="Set-RemediationGraphObject -Uri $intuneMdm -Body @{ appliesTo = $wanted }\nforeach ($g in @($GroupId | Where-Object { $_ })) {\n    Set-RemediationGraphObject -Uri \"$intuneMdm/includedGroups/`$ref\" -Method POST -Body @{ '@odata.id' = \"https://graph.microsoft.com/beta/groups/$g\" }\n}")])
print('ok')
