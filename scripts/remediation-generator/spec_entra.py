from gen import emit, graph_props, graph_step, ca_emit, ca_users, cmdlet_props

AUTHZ = '/v1.0/policies/authorizationPolicy'
AUTHZ_SC = ['Policy.ReadWrite.Authorization']
AMP = '/v1.0/policies/authenticationMethodsPolicy'
AMP_BETA = '/beta/policies/authenticationMethodsPolicy'
AMP_SC = ['Policy.ReadWrite.AuthenticationMethod']
EMPTY = '$null -eq $State -or @($State).Count -eq 0'
GA = '62e90394-69f5-4237-9190-012177145e10'
TIER0 = {
    '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
    'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
    '7be44c8a-adaf-4e2a-84d6-ab2649e08a13': 'Privileged Authentication Administrator',
    '194ae4cb-b126-40b2-bd5b-6091b380977d': 'Security Administrator',
    'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9': 'Conditional Access Administrator',
    '8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2': 'Hybrid Identity Administrator',
    '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3': 'Application Administrator',
    '158c047a-c907-4556-b7ef-446551a6b5f7': 'Cloud Application Administrator',
}
TIER1 = {
    '29232cdf-9323-42fd-ade2-1d097af3e4de': 'Exchange Administrator',
    'f28a1f50-f6e7-4571-818b-6a12f2af6b6c': 'SharePoint Administrator',
    'fe930be7-5e62-47db-91af-98c3a49a38b1': 'User Administrator',
    '3a2c62db-5318-420d-8d74-23affee5d9d5': 'Intune Administrator',
    'c4e39bd9-1100-46d3-8c65-fb160da0071f': 'Authentication Administrator',
    '729827e3-9c14-49f7-bb1b-9608f156bbb8': 'Helpdesk Administrator',
    'fdd7a751-b60b-444a-984c-02652fe8fa1c': 'Groups Administrator',
    '69091246-20e8-4a56-aa4d-066075b2a7a8': 'Teams Administrator',
}


def role_param(roles, label):
    items = list(roles.items())
    lines = '\n    '.join(f"'{k}'{',' if i < len(items) - 1 else ''} # {v}" for i, (k, v) in enumerate(items))
    # comments inside an array literal are fine in PowerShell
    return (f"RoleDefinitionId = @(\n    {lines}\n)", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string[]]",
            f'{label} role template IDs to change. Defaults to the {label} roles listed in the script.')


def authz(cid, body, desc, notes='', expected=None):
    graph_props(cid, uri=AUTHZ, body=body, scopes=AUTHZ_SC, target='Entra authorization policy', desc=desc, notes=notes,
                expected=expected)


# ------------------------------------------------------------ authorization policy
authz('ENTRA-APPREG-001', {'defaultUserRolePermissions': {'allowedToCreateApps': False}},
      'Stops non-admin users from registering applications.',
      'Developers then need the Application Developer role (or an admin) to register apps.')
authz('ENTRA-APPS-001', {'defaultUserRolePermissions': {'allowedToCreateApps': False}},
      'Stops non-admin users from registering (integrating) third-party applications.',
      'User consent to apps is a separate setting; see ENTRA-CONSENT-001.')
authz('ENTRA-GROUP-001', {'defaultUserRolePermissions': {'allowedToCreateSecurityGroups': False}},
      'Stops non-admin users from creating security groups.')
authz('ENTRA-TENANT-001', {'defaultUserRolePermissions': {'allowedToCreateTenants': False}},
      'Stops non-admin users from creating new Entra tenants.')
authz('ENTRA-DEVICE-006', {'defaultUserRolePermissions': {'allowedToReadBitlockerKeysForOwnedDevice': False}},
      'Stops users from reading the BitLocker recovery keys of devices they own; recovery goes\nthrough the helpdesk instead.')
authz('ENTRA-APPS-003', {'blockMsolPowerShell': True},
      'Blocks the legacy MSOnline and AzureAD PowerShell modules for non-admin users.',
      'Scripts still using those modules must move to the Microsoft Graph PowerShell SDK.')
authz('ENTRA-SSPR-002', {'allowedToUseSSPR': False},
      'Turns off self-service password reset for administrator accounts. Admin password resets then\nfollow your helpdesk / PIM process.',
      'Applies to admin roles only; user SSPR is unchanged. Make sure admins have another reset path\n(another admin, or break-glass accounts) before running.')

KEEP = ("# Keep resource-specific consent entries (ManagePermissionGrantsForOwnedResource.*); only user self-consent changes.\n"
        "$keep = @($State['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'] | Where-Object { $_ -and \"$_\" -notlike 'ManagePermissionGrantsForSelf.*' })")
CONSENT_PRELUDE = ("$current = @((Get-RemediationGraphObject -Uri '" + AUTHZ + "')['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'])\n"
                   "# Keep resource-specific consent entries (ManagePermissionGrantsForOwnedResource.*); only user self-consent changes.\n"
                   "$keep = @($current | Where-Object { \"$_\" -notlike 'ManagePermissionGrantsForSelf.*' })")
for cid, desc in (('ENTRA-CONSENT-001', 'Turns off user consent to applications, so only admins can grant apps access to company\ndata.'),
                  ('ENTRA-ORGSETTING-001', 'Restricts "user owned apps and services" by turning off user consent to applications.')):
    emit(cid, desc=desc, desired='No ManagePermissionGrantsForSelf.* policy assigned to users',
         services=['Graph'], scopes=AUTHZ_SC,
         notes='Resource-specific consent entries (ManagePermissionGrantsForOwnedResource.*) are kept.\nUsers then request apps through the admin consent workflow (ENTRA-CONSENT-002).',
         steps=[dict(target='Entra authorization policy (user consent)', desired='User consent off',
                     get=f"Get-RemediationGraphObject -Uri '{AUTHZ}'",
                     test="@($State['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'] | Where-Object { \"$_\" -like 'ManagePermissionGrantsForSelf.*' }).Count -eq 0",
                     set=KEEP + f"\nSet-RemediationGraphObject -Uri '{AUTHZ}' -Body @{{ defaultUserRolePermissions = @{{ permissionGrantPoliciesAssigned = $keep }} }}")])

emit('ENTRA-CONSENT-003',
     desc='Limits user consent to apps from verified publishers requesting low-impact permissions, or\nturns user consent off entirely.',
     desired='User consent off, or only microsoft-user-default-low',
     services=['Graph'], scopes=AUTHZ_SC,
     params=[("Mode = 'Block'", "[Parameter()]\n[ValidateSet('Block', 'VerifiedPublishersLowRisk')]\n[string]",
              'Block (default): no user consent. VerifiedPublishersLowRisk: users may consent to\nverified-publisher apps asking for low-impact permissions.')],
     notes='The assessment check compares the policy list to the short name "microsoft-user-default-low"\nwhile Graph returns "ManagePermissionGrantsForSelf.microsoft-user-default-low", so only Block\nis currently recognized as passing; VerifiedPublishersLowRisk is still the CIS-acceptable option.',
     prelude="$wanted = if ($Mode -eq 'Block') { @() } else { @('ManagePermissionGrantsForSelf.microsoft-user-default-low') }",
     steps=[dict(target='Entra authorization policy (user consent)', desired='"User consent: $Mode"',
                 get=f"Get-RemediationGraphObject -Uri '{AUTHZ}'",
                 test="$self = @($State['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'] | Where-Object { \"$_\" -like 'ManagePermissionGrantsForSelf.*' } | Sort-Object)\n($self -join ',') -eq (@($wanted | Sort-Object) -join ',')",
                 set=KEEP + f"\nSet-RemediationGraphObject -Uri '{AUTHZ}' -Body @{{ defaultUserRolePermissions = @{{ permissionGrantPoliciesAssigned = @($keep + $wanted) }} }}")])

# ------------------------------------------------------------ admin consent workflow
ACR = '/v1.0/policies/adminConsentRequestPolicy'
ACR_SC = ['Policy.ReadWrite.ConsentRequest']
ACR_PUT = ("$reviewers = @($ReviewerId | Where-Object { $_ } | ForEach-Object { @{ query = \"/users/$_\"; queryType = 'MicrosoftGraph'; queryRoot = $null } })\n"
           "if ($reviewers.Count -eq 0) { $reviewers = @($State['reviewers']) }\n"
           "if ($reviewers.Count -eq 0) { throw 'The admin consent workflow needs at least one reviewer. Pass -ReviewerId.' }\n"
           "$body = @{\n    isEnabled             = $true\n    notifyReviewers       = $true\n    remindersEnabled      = $true\n    requestDurationInDays = if ($State['requestDurationInDays']) { $State['requestDurationInDays'] } else { 30 }\n    reviewers             = $reviewers\n}\n"
           f"Set-RemediationGraphObject -Uri '{ACR}' -Method PUT -Body $body")
REV_PARAM = lambda mandatory: ('ReviewerId', f"[Parameter({'Mandatory' if mandatory else ''})]\n" + ("[ValidateNotNullOrEmpty()]\n" if mandatory else '') + "[string[]]",
                               'Object IDs of users who review admin consent requests. Use Application or Cloud\nApplication Administrators, not Global Administrators.' + ('' if mandatory else '\nOmit to keep the current reviewers.'))
for cid, mand, desc, test in (
        ('ENTRA-CONSENT-002', False, 'Turns on the admin consent workflow so users can request apps they cannot consent to.',
         "$State['isEnabled'] -eq $true -and @($State['reviewers']).Count -gt 0"),
        ('ENTRA-CONSENT-005', True, 'Sets designated reviewers for admin consent requests (and makes sure the workflow is on).',
         "$want = @($ReviewerId | ForEach-Object { \"/users/$_\" })\n$have = @($State['reviewers'] | ForEach-Object { $_['query'] })\n$State['isEnabled'] -eq $true -and @($want | Where-Object { $have -notcontains $_ }).Count -eq 0"),
        ('ENTRA-CONSENT-006', False, 'Turns on email notifications to reviewers for new admin consent requests.',
         "$State['isEnabled'] -eq $true -and $State['notifyReviewers'] -eq $true")):
    emit(cid, desc=desc, desired='Admin consent workflow on, reviewers set, notifications on', services=['Graph'], scopes=ACR_SC,
         params=[REV_PARAM(mand)], example_args="-ReviewerId '00000000-0000-0000-0000-000000000001'" if mand else '',
         notes='The workflow is configured with one PUT, so this script also enables the workflow,\nnotifications, and reminders. Without -ReviewerId the existing reviewers are kept; if there\nare none the step reports Failed.',
         steps=[dict(target='Admin consent request policy', desired='Enabled with reviewers and notifications',
                     get=f"Get-RemediationGraphObject -Uri '{ACR}'", test=test, set=ACR_PUT)])

# ------------------------------------------------------------ authentication methods
def method(cid, mid, odata, body, desc, notes='', expected=None):
    b = {'@odata.type': f'#microsoft.graph.{odata}'}
    b.update(body)
    graph_props(cid, uri=f'{AMP}/authenticationMethodConfigurations/{mid}', body=b, scopes=AMP_SC,
                expected=expected if expected is not None else {k: v for k, v in __import__('gen').flat(body).items()},
                target=f'Authentication method {mid}', desc=desc, notes=notes)


method('ENTRA-AUTHMETHOD-002', 'Email', 'emailAuthenticationMethodConfiguration', {'state': 'disabled'},
       'Turns off email one-time passcode as an authentication method.',
       'Guests who redeem invitations with an email one-time passcode (no Microsoft or Entra account)\nare also affected; check External collaboration settings before running.')
method('ENTRA-AUTHMETHOD-003', 'MicrosoftAuthenticator', 'microsoftAuthenticatorAuthenticationMethodConfiguration',
       {'featureSettings': {'displayAppInformationRequiredState': {'state': 'enabled', 'includeTarget': {'targetType': 'group', 'id': 'all_users'}},
                            'displayLocationInformationRequiredState': {'state': 'enabled', 'includeTarget': {'targetType': 'group', 'id': 'all_users'}}}},
       'Shows the application name and sign-in location in Microsoft Authenticator push requests\n(number matching is always on), to protect against MFA fatigue.',
       expected={'featureSettings.displayAppInformationRequiredState.state': 'enabled',
                 'featureSettings.displayLocationInformationRequiredState.state': 'enabled'})
method('ENTRA-AUTHMETHOD-008', 'TemporaryAccessPass', 'temporaryAccessPassAuthenticationMethodConfiguration', {'isUsableOnce': True},
       'Makes Temporary Access Passes single-use.')

emit('ENTRA-AUTHMETHOD-007',
     desc='Turns on the Temporary Access Pass method for onboarding and recovery, single-use with a\nshort lifetime, for all users or the groups you choose.',
     desired='TemporaryAccessPass enabled, single-use, 1-8 hour lifetime',
     services=['Graph'], scopes=AMP_SC,
     params=[('IncludeGroupId', "[Parameter()]\n[string[]]", 'Groups allowed to use a TAP. Defaults to all users.'),
             ('DefaultLifetimeMinutes = 60', "[Parameter()]\n[ValidateRange(60, 480)]\n[int]", 'Default TAP lifetime (60-480 minutes).')],
     prelude="$targets = if (@($IncludeGroupId | Where-Object { $_ }).Count -gt 0) {\n    @($IncludeGroupId | ForEach-Object { @{ targetType = 'group'; id = $_; isRegistrationRequired = $false } })\n}\nelse {\n    @(@{ targetType = 'group'; id = 'all_users'; isRegistrationRequired = $false })\n}",
     steps=[dict(target='Authentication method TemporaryAccessPass', desired='Enabled, single-use',
                 get=f"Get-RemediationGraphObject -Uri '{AMP}/authenticationMethodConfigurations/TemporaryAccessPass'",
                 test="$State['state'] -eq 'enabled' -and $State['isUsableOnce'] -eq $true -and [int]$State['maximumLifetimeInMinutes'] -le 480",
                 set=f"$body = @{{\n    '@odata.type'            = '#microsoft.graph.temporaryAccessPassAuthenticationMethodConfiguration'\n    state                    = 'enabled'\n    isUsableOnce             = $true\n    defaultLifetimeInMinutes = $DefaultLifetimeMinutes\n    minimumLifetimeInMinutes = 60\n    maximumLifetimeInMinutes = 480\n    includeTargets           = $targets\n}}\nSet-RemediationGraphObject -Uri '{AMP}/authenticationMethodConfigurations/TemporaryAccessPass' -Body $body")])

emit('ENTRA-AUTHMETHOD-001',
     desc='Turns off SMS and voice call as authentication methods (vulnerable to SIM swapping).',
     desired='Sms and Voice methods disabled',
     services=['Graph'], scopes=AMP_SC,
     params=[('KeepVoice', "[Parameter()]\n[switch]", 'Only disable SMS; leave voice call as it is.')],
     notes='Users who only have SMS or voice registered lose their MFA method and are prompted to\nregister another one. Run a registration campaign (ENTRA-MFA-001) first, and check the\nauthentication methods activity report for SMS-only users.',
     steps=[graph_step(uri=f'{AMP}/authenticationMethodConfigurations/Sms', target='Authentication method Sms',
                       body={'@odata.type': '#microsoft.graph.smsAuthenticationMethodConfiguration', 'state': 'disabled'},
                       expected={'state': 'disabled'}),
            graph_step(uri=f'{AMP}/authenticationMethodConfigurations/Voice', target='Authentication method Voice',
                       body={'@odata.type': '#microsoft.graph.voiceAuthenticationMethodConfiguration', 'state': 'disabled'},
                       expected={'state': 'disabled'}, test="$KeepVoice.IsPresent -or $State['state'] -eq 'disabled'")])

graph_props('ENTRA-AUTHMETHOD-004', uri=AMP_BETA, scopes=AMP_SC, target='Authentication methods policy (system-preferred MFA)',
            body={'systemCredentialPreferences': {'state': 'enabled', 'includeTargets': [{'targetType': 'group', 'id': 'all_users'}], 'excludeTargets': []}},
            expected={'systemCredentialPreferences.state': 'enabled'},
            desc='Turns on system-preferred MFA, so users are prompted for their strongest registered method.',
            notes='Uses the Graph beta authentication methods policy.')
graph_props('ENTRA-AUTHMETHOD-006', uri=AMP_BETA, scopes=AMP_SC, target='Authentication methods policy (report suspicious activity)',
            body={'reportSuspiciousActivitySettings': {'state': 'enabled', 'includeTarget': {'targetType': 'group', 'id': 'all_users'}, 'voiceReportingCode': 0}},
            expected={'reportSuspiciousActivitySettings.state': 'enabled'},
            desc='Lets users report unexpected MFA prompts as suspicious, which raises a user risk event.',
            notes='Uses the Graph beta authentication methods policy.')
graph_props('ENTRA-AUTHMETHOD-005', uri=AMP, scopes=AMP_SC, target='Authentication methods policy (migration state)',
            body={'policyMigrationState': 'migrationComplete'},
            desc='Marks the authentication methods migration complete, so methods are managed only in the\nAuthentication methods policy.',
            notes='After this, the legacy per-user MFA and SSPR method settings stop applying. Check that every\nmethod you rely on is enabled in the Authentication methods policy first.')

CAMPAIGN = {'registrationEnforcement': {'authenticationMethodsRegistrationCampaign': {
    'state': 'enabled', 'snoozeDurationInDays': 1, 'enforceRegistrationAfterAllowedSnoozes': True,
    'includeTargets': [{'id': 'all_users', 'targetType': 'group', 'targetedAuthenticationMethod': 'microsoftAuthenticator'}], 'excludeTargets': []}}}
for cid, d in (('ENTRA-MFA-001', 'so every member user becomes MFA capable'),
               ('ENTRA-MFA-002', 'to reduce the share of users without an MFA method'),
               ('ENTRA-SSPR-001', 'to nudge users toward stronger methods')):
    graph_props(cid, uri=AMP, scopes=AMP_SC, target='Authentication methods registration campaign', body=CAMPAIGN,
                expected={'registrationEnforcement.authenticationMethodsRegistrationCampaign.state': 'enabled'},
                desc=f'Turns on the Microsoft Authenticator registration campaign for all users {d}.',
                notes='Users can snooze the prompt once a day, up to three times, before registration is required.')

graph_props('ENTRA-ORGSETTING-002', uri='/beta/admin/forms/settings', body={'isPhishingScanEnabled': True},
            scopes=['OrgSettings-Forms.ReadWrite.All'], target='Microsoft Forms org settings',
            desc='Turns on internal phishing protection in Microsoft Forms.',
            notes='Same setting as FORMS-CONFIG-004. Uses a Graph beta endpoint.')

# ------------------------------------------------------------ device registration policy
DRP = '/beta/policies/deviceRegistrationPolicy'
DRP_SC = ['Policy.ReadWrite.DeviceConfiguration']


def drp(cid, desc, test, change, params=(), notes='', example=''):
    emit(cid, desc=desc, desired='Device registration policy updated', services=['Graph'], scopes=DRP_SC, params=params,
         example_args=example,
         notes=('Uses the Graph beta device registration policy, which is updated with a full PUT of the\ncurrent policy plus the change. ' + notes).strip(),
         steps=[dict(target='Entra device registration policy', desired=desc.split('\n')[0].rstrip('.'),
                     get=f"Get-RemediationGraphObject -Uri '{DRP}'", test=test,
                     set="$body = @{}\nforeach ($key in $State.Keys) { if ($key -notlike '@odata.*') { $body[$key] = $State[$key] } }\n" + change +
                     f"\nSet-RemediationGraphObject -Uri '{DRP}' -Method PUT -Body $body")])


drp('ENTRA-DEVICE-001', 'Limits who can join devices to Microsoft Entra to the groups you choose.',
    "$State['azureADJoin']['allowedToJoin']['@odata.type'] -ne '#microsoft.graph.allDeviceRegistrationMembership'",
    "$body['azureADJoin']['allowedToJoin'] = @{ '@odata.type' = '#microsoft.graph.enumeratedDeviceRegistrationMembership'; users = @(); groups = @($AllowedGroupId) }",
    params=[('AllowedGroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Groups whose members may join devices to Entra (for example, IT and Autopilot accounts).')],
    example="-AllowedGroupId '00000000-0000-0000-0000-000000000001'",
    notes='Autopilot and bulk enrollment accounts must be in an allowed group.')
drp('ENTRA-DEVICE-002', 'Limits the number of devices each user can join or register.',
    "$null -ne $State['userDeviceQuota'] -and [int]$State['userDeviceQuota'] -le $MaxDevices",
    "$body['userDeviceQuota'] = $MaxDevices",
    params=[('MaxDevices = 15', "[Parameter()]\n[ValidateRange(1, 15)]\n[int]", 'Maximum devices per user (1-15). An existing lower limit is kept.')])
drp('ENTRA-DEVICE-003', 'Stops Global Administrators being added to the local Administrators group on Entra-joined devices.',
    "$State['azureADJoin']['localAdmins']['enableGlobalAdmins'] -eq $false",
    "$body['azureADJoin']['localAdmins']['enableGlobalAdmins'] = $false",
    notes='Use Windows LAPS (ENTRA-DEVICE-005) or Intune for local admin access instead.')
drp('ENTRA-DEVICE-004', 'Removes the "additional local administrators on all Entra joined devices" assignment.',
    "\"$($State['azureADJoin']['localAdmins']['registeredUsers']['@odata.type'])\" -match 'noDeviceRegistrationMembership'",
    "$body['azureADJoin']['localAdmins']['registeredUsers'] = @{ '@odata.type' = '#microsoft.graph.noDeviceRegistrationMembership' }",
    notes='Users listed there lose local admin on every Entra-joined device. Grant scoped access\nwith Intune Endpoint privilege management or Account protection policies instead.')
drp('ENTRA-DEVICE-005', 'Turns on Microsoft Entra Local Administrator Password Solution (LAPS).',
    "$State['localAdminPassword']['isEnabled'] -eq $true",
    "$body['localAdminPassword'] = @{ isEnabled = $true }",
    notes='Devices also need a Windows LAPS policy (Intune > Endpoint security > Account protection)\nto start backing up passwords.')

# ------------------------------------------------------------ password policy
PWT = '5cf42378-d67d-4f36-ba46-e8b86229381d'
PW_SC = ['Directory.ReadWrite.All']
emit('ENTRA-PASSWORD-003',
     desc='Sets the smart lockout threshold to 10 failed sign-ins or fewer.',
     desired='LockoutThreshold <= -Threshold', services=['Graph'], scopes=PW_SC,
     params=[('Threshold = 10', "[Parameter()]\n[ValidateRange(1, 10)]\n[int]", 'Failed attempts before lockout (1-10). An existing lower threshold is kept.')],
     steps=[dict(target='Password rule settings (smart lockout)', desired='"Threshold $Threshold or lower"',
                 get=f"Get-RemediationDirectorySetting -TemplateId '{PWT}'",
                 test="$null -ne $State -and $null -ne $State['LockoutThreshold'] -and [int]$State['LockoutThreshold'] -le $Threshold",
                 set=f"Set-RemediationDirectorySetting -TemplateId '{PWT}' -Values @{{ LockoutThreshold = \"$Threshold\" }}")])
for cid, desc in (('ENTRA-PASSWORD-002', 'Turns on the custom banned password list and adds your organization-specific terms.'),
                  ('ENTRA-PASSWORD-004', 'Adds organization-specific terms (brand, product, and location names) to the custom banned\npassword list and makes sure it is enforced.')):
    emit(cid, desc=desc, desired='EnableBannedTermCheck = True; BannedTermList includes -BannedTerm',
         services=['Graph'], scopes=PW_SC,
         params=[('BannedTerm', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Terms to ban (up to 1000, 4-16 characters each). Existing terms are kept.')],
         example_args="-BannedTerm 'contoso', 'fabrikam'",
         notes='Requires Entra ID P1. Users are only blocked from these terms on their next password change.',
         steps=[dict(target='Password rule settings (custom banned passwords)', desired='Enforced with the given terms',
                     get=f"Get-RemediationDirectorySetting -TemplateId '{PWT}'",
                     test="$have = @(\"$($State['BannedTermList'])\" -split \"`t\" | Where-Object { $_ })\n$null -ne $State -and \"$($State['EnableBannedTermCheck'])\" -eq 'True' -and @($BannedTerm | Where-Object { $have -notcontains $_ }).Count -eq 0",
                     set=f"$have = @(\"$($State['BannedTermList'])\" -split \"`t\" | Where-Object {{ $_ }})\n$list = @($have + $BannedTerm | Sort-Object -Unique) -join \"`t\"\nSet-RemediationDirectorySetting -TemplateId '{PWT}' -Values @{{ EnableBannedTermCheck = 'True'; BannedTermList = $list }}")])

emit('ENTRA-PASSWORD-001',
     desc='Sets passwords to never expire on every managed (cloud-authenticated) verified domain.',
     desired='passwordValidityPeriodInDays = 2147483647 on managed domains',
     services=['Graph'], scopes=['Domain.ReadWrite.All'],
     notes='Only appropriate with MFA enforced. Federated domains are skipped; their password policy\nlives in the on-premises directory.',
     steps=[dict(target='Managed domains with password expiration', desired='Never expire',
                 get="@(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/domains' -OutputType HashTable)['value']) | Where-Object {\n    $null -ne $_ -and $_['isVerified'] -eq $true -and $_['authenticationType'] -eq 'Managed' -and $_['passwordValidityPeriodInDays'] -ne 2147483647\n} | ForEach-Object { $_['id'] })",
                 test=EMPTY,
                 set="foreach ($domain in $State) {\n    Set-RemediationGraphObject -Uri \"/v1.0/domains/$domain\" -Body @{ passwordValidityPeriodInDays = 2147483647 }\n}")])

# ------------------------------------------------------------ groups
emit('ENTRA-GROUP-002',
     desc='Creates a dynamic security group containing every guest user, for targeting guest policies\nand access reviews.',
     desired='A dynamic group with rule (user.userType -eq "Guest") exists',
     services=['Graph'], scopes=['Group.ReadWrite.All'],
     params=[("GroupName = 'All Guest Users (dynamic)'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Display name of the group to create.')],
     notes='Requires Entra ID P1 for dynamic membership.',
     steps=[dict(target='Dynamic guest group', desired='Exists',
                 get="@(@((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups?`$filter=groupTypes/any(c:c eq 'DynamicMembership')&`$select=id,displayName,membershipRule&`$top=999\" -OutputType HashTable)['value']) |\n    Where-Object { $null -ne $_ -and \"$($_['membershipRule'])\" -match 'user\\.userType\\s+-eq\\s+\"Guest\"' })",
                 test='@($State).Count -gt 0',
                 set="$nickname = ($GroupName -replace '[^A-Za-z0-9]', '').ToLowerInvariant()\n$group = @{\n    displayName                   = $GroupName\n    description                   = 'All guest users. Created by M365-Assess remediation ENTRA-GROUP-002.'\n    mailEnabled                   = $false\n    mailNickname                  = $nickname\n    securityEnabled               = $true\n    groupTypes                    = @('DynamicMembership')\n    membershipRule                = '(user.userType -eq \"Guest\")'\n    membershipRuleProcessingState = 'On'\n}\nSet-RemediationGraphObject -Uri '/v1.0/groups' -Method POST -Body $group")])

emit('ENTRA-GROUP-003',
     desc='Gives every ownerless public Microsoft 365 group an owner, or makes those groups private.',
     desired='No public Microsoft 365 group without an owner',
     services=['Graph'], scopes=['Group.ReadWrite.All'],
     params=[('Action', "[Parameter(Mandatory)]\n[ValidateSet('AddOwner', 'MakePrivate')]\n[string]", 'AddOwner: add -OwnerId as owner. MakePrivate: change visibility to Private.'),
             ('OwnerId', "[Parameter()]\n[string]", 'Object ID of the user to add as owner (required with -Action AddOwner).')],
     example_args="-Action AddOwner -OwnerId '00000000-0000-0000-0000-000000000001'",
     steps=[dict(target='Ownerless public Microsoft 365 groups', desired='None',
                 get="@(@((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups?`$filter=groupTypes/any(c:c eq 'Unified')&`$select=id,displayName,visibility&`$top=999\" -OutputType HashTable)['value']) |\n    Where-Object { $null -ne $_ -and $_['visibility'] -eq 'Public' } |\n    Where-Object { @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups/$($_['id'])/owners?`$select=id\" -OutputType HashTable)['value']).Count -eq 0 } |\n    ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName'] } })",
                 test=EMPTY,
                 set="if ($Action -eq 'AddOwner' -and [string]::IsNullOrWhiteSpace($OwnerId)) { throw 'Pass -OwnerId with -Action AddOwner.' }\nforeach ($group in $State) {\n    if ($Action -eq 'AddOwner') {\n        Set-RemediationGraphObject -Uri \"/v1.0/groups/$($group.Id)/owners/`$ref\" -Method POST -Body @{ '@odata.id' = \"https://graph.microsoft.com/v1.0/directoryObjects/$OwnerId\" }\n    }\n    else {\n        Set-RemediationGraphObject -Uri \"/v1.0/groups/$($group.Id)\" -Body @{ visibility = 'Private' }\n    }\n}")])

emit('ENTRA-GROUP-004',
     desc='Converts the dynamic groups you name to assigned membership, freezing their current members,\nso users cannot add themselves by editing attributes such as department or job title.',
     desired='Listed groups use assigned membership',
     services=['Graph'], scopes=['Group.ReadWrite.All'],
     params=[('GroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of the dynamic groups to convert (those used for role, app, or CA assignment).')],
     example_args="-GroupId '00000000-0000-0000-0000-000000000001'",
     notes='Current members are kept; membership no longer updates automatically. Alternatively, rewrite\nthe rule to use HR-sourced attributes (employeeId, extension attributes synced from HR).',
     steps=[dict(target='Dynamic groups to convert', desired='Assigned membership',
                 get="@(foreach ($id in $GroupId) {\n    $g = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups/$id`?`$select=id,displayName,groupTypes,membershipRule\" -OutputType HashTable\n    if (@($g['groupTypes']) -contains 'DynamicMembership') { [PSCustomObject]@{ Id = $g['id']; DisplayName = $g['displayName']; GroupTypes = @($g['groupTypes']); MembershipRule = $g['membershipRule'] } }\n})",
                 test=EMPTY,
                 set="foreach ($group in $State) {\n    $types = @($group.GroupTypes | Where-Object { $_ -ne 'DynamicMembership' })\n    Set-RemediationGraphObject -Uri \"/v1.0/groups/$($group.Id)\" -Body @{ groupTypes = $types; membershipRuleProcessingState = 'Paused' }\n}")])

emit('ENTRA-GROUP-005',
     desc='Creates a role-assignable (protected) copy of each sensitive group you name, with the same\nmembers. Role-assignable groups can only be managed by Privileged Role Administrators.',
     desired='A role-assignable replacement exists for each -SourceGroupId',
     services=['Graph'], scopes=['Group.ReadWrite.All', 'RoleManagement.ReadWrite.Directory'],
     params=[('SourceGroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of the sensitive security groups to replace.'),
             ("Suffix = ' (protected)'", "[Parameter()]\n[string]", 'Text appended to the display name of each new group.')],
     example_args="-SourceGroupId '00000000-0000-0000-0000-000000000001'",
     notes='isAssignableToRole cannot be turned on for an existing group. After this runs, move CA,\napp-role, and license assignments to the new groups, then delete the originals; the check\nonly clears once the originals are gone.',
     steps=[dict(target='Role-assignable replacement groups', desired='Created',
                 get="@(foreach ($id in $SourceGroupId) {\n    $g = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups/$id`?`$select=id,displayName,mailNickname,isAssignableToRole\" -OutputType HashTable\n    if ($g['isAssignableToRole'] -ne $true) {\n        $name = \"$($g['displayName'])$Suffix\"\n        $existing = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups?`$filter=displayName eq '$($name.Replace(\"'\", \"''\"))'&`$select=id\" -OutputType HashTable)['value'])\n        if ($existing.Count -eq 0) { [PSCustomObject]@{ SourceId = $g['id']; NewName = $name; Nickname = \"$($g['mailNickname'])-protected\" } }\n    }\n})",
                 test=EMPTY,
                 set="foreach ($item in $State) {\n    $new = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/groups' -OutputType HashTable -ContentType 'application/json' -Body (@{\n        displayName = $item.NewName; mailEnabled = $false; mailNickname = $item.Nickname; securityEnabled = $true; isAssignableToRole = $true\n    } | ConvertTo-Json)\n    $members = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups/$($item.SourceId)/members?`$select=id&`$top=999\" -OutputType HashTable)['value'])\n    foreach ($member in $members) {\n        Set-RemediationGraphObject -Uri \"/v1.0/groups/$($new['id'])/members/`$ref\" -Method POST -Body @{ '@odata.id' = \"https://graph.microsoft.com/v1.0/directoryObjects/$($member['id'])\" }\n    }\n    Write-Warning \"Created $($item.NewName) ($($new['id'])). Move assignments from $($item.SourceId), then delete it.\"\n}")])

# ------------------------------------------------------------ guests
emit('ENTRA-GUEST-004',
     desc='Restricts who can invite guests and limits invitations to the external domains you allow.',
     desired='allowInvitesFrom restricted; B2B invitations allowed only to -AllowedDomain',
     services=['Graph'], scopes=['Policy.ReadWrite.Authorization', 'Policy.ReadWrite.B2BManagement'],
     params=[('AllowedDomain', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'External domains guests may be invited from. Replaces the current list.'),
             ("AllowInvitesFrom = 'adminsAndGuestInviters'", "[Parameter()]\n[ValidateSet('adminsAndGuestInviters', 'adminsGuestInvitersAndAllMembers', 'none')]\n[string]", 'Who can invite guests.')],
     example_args="-AllowedDomain 'partner.example'",
     notes='The domain list is written to the B2BManagementPolicy through the Graph beta /legacy/policies\nendpoint, the same store the External collaboration settings page uses.',
     steps=[graph_step(uri=AUTHZ, target='Entra authorization policy (guest invitations)', body={'allowInvitesFrom': '$AllowInvitesFrom'},
                       expected={'allowInvitesFrom': '$AllowInvitesFrom'}),
            dict(target='B2B collaboration domain allow-list', desired='Only -AllowedDomain',
                 get="$policy = @((Invoke-MgGraphRequest -Method GET -Uri '/beta/legacy/policies' -OutputType HashTable)['value']) | Where-Object { $null -ne $_ -and $_['type'] -eq 'B2BManagementPolicy' } | Select-Object -First 1\nif ($null -eq $policy) { return $null }\n$definition = (@($policy['definition']) -join '') | ConvertFrom-Json -AsHashtable\n[PSCustomObject]@{ Id = $policy['id']; Definition = $definition; Allowed = @($definition['B2BManagementPolicy']['InvitationsAllowedAndBlockedDomainsPolicy']['AllowedDomains']) }",
                 test="$null -ne $State -and ((@($State.Allowed | Sort-Object) -join ',') -eq (@($AllowedDomain | Sort-Object) -join ','))",
                 set="$definition = if ($null -ne $State) { $State.Definition } else { @{ B2BManagementPolicy = @{} } }\n$definition['B2BManagementPolicy']['InvitationsAllowedAndBlockedDomainsPolicy'] = @{ AllowedDomains = @($AllowedDomain) }\n$body = @{ definition = @(($definition | ConvertTo-Json -Depth 10 -Compress)) }\nif ($null -ne $State) {\n    Set-RemediationGraphObject -Uri \"/beta/legacy/policies/$($State.Id)\" -Body $body\n}\nelse {\n    $body['displayName'] = 'B2BManagementPolicy'\n    $body['type'] = 'B2BManagementPolicy'\n    $body['isOrganizationDefault'] = $true\n    Set-RemediationGraphObject -Uri '/beta/legacy/policies' -Method POST -Body $body\n}")])

# ------------------------------------------------------------ PIM rules (tier-0)
PIM_SC = ['RoleManagementPolicy.ReadWrite.Directory']


def pim_rule(cid, rule_id, desc, test, changes, params=(), notes='', example='', roles=TIER0, label='Tier-0', prelude=''):
    emit(cid, desc=desc, desired='PIM rule updated for each role', services=['Graph'], scopes=PIM_SC, prelude=prelude,
         params=[role_param(roles, label)] + list(params), example_args=example,
         notes=('Requires Entra ID P2 (PIM). ' + notes).strip(),
         steps=[dict(target=f'"PIM rule {rule_id} for roles: $($RoleDefinitionId -join \', \')"', desired='Updated',
                     get=f"@(foreach ($roleId in $RoleDefinitionId) {{\n    $rule = Get-RemediationPimRule -RoleDefinitionId $roleId -RuleId '{rule_id}'\n    $rule['roleDefinitionId'] = $roleId\n    $rule\n}})",
                     test=f"@($State | Where-Object {{ $rule = $_; -not ({test}) }}).Count -eq 0",
                     set=f"foreach ($rule in @($State | Where-Object {{ $rule = $_; -not ({test}) }})) {{\n    $current = @{{}}\n    foreach ($key in $rule.Keys) {{ if ($key -ne 'roleDefinitionId') {{ $current[$key] = $rule[$key] }} }}\n    Set-RemediationPimRule -Current $current -Changes ({changes})\n}}")])


pim_rule('ENTRA-PIM-006', 'Expiration_EndUser_Assignment', 'Caps Tier-0 role activation at 4 hours or less.',
         "[System.Xml.XmlConvert]::ToTimeSpan(\"$($rule['maximumDuration'])\") -le [timespan]::FromHours($MaxHours)",
         "@{ isExpirationRequired = $true; maximumDuration = \"PT$($MaxHours)H\" }",
         params=[('MaxHours = 4', "[Parameter()]\n[ValidateRange(1, 4)]\n[int]", 'Maximum activation duration in hours (1-4).')])
pim_rule('ENTRA-PIM-007', 'Enablement_EndUser_Assignment', 'Requires a justification when Tier-0 roles are activated.',
         "@($rule['enabledRules']) -contains 'Justification'",
         "@{ enabledRules = @(@($rule['enabledRules']) + 'Justification' | Sort-Object -Unique) }")
pim_rule('ENTRA-PIM-008', 'Enablement_EndUser_Assignment', 'Requires MFA when Tier-0 roles are activated.',
         "@($rule['enabledRules']) -contains 'MultiFactorAuthentication'",
         "@{ enabledRules = @(@($rule['enabledRules']) + 'MultiFactorAuthentication' | Sort-Object -Unique) }",
         notes='If the role uses an authentication context for activation instead, MFA is already\nenforced by that CA policy.')
pim_rule('ENTRA-PIM-009', 'Expiration_Admin_Eligibility', 'Stops permanent eligible assignments for Tier-0 roles: eligible assignments must expire.',
         "$rule['isExpirationRequired'] -eq $true -and [System.Xml.XmlConvert]::ToTimeSpan(\"$($rule['maximumDuration'])\") -le [timespan]::FromDays($MaxDays)",
         "@{ isExpirationRequired = $true; maximumDuration = \"P$($MaxDays)D\" }",
         params=[('MaxDays = 365', "[Parameter()]\n[ValidateRange(15, 365)]\n[int]", 'Maximum eligible assignment length in days.')],
         notes='Existing permanent eligible assignments keep running until changed; reissue them as\ntime-bound assignments.')
pim_rule('ENTRA-PIM-010', 'Notification_Admin_EndUser_Assignment', 'Sends an email to the addresses you choose whenever a Tier-0 role is activated.',
         "@($NotifyAddress | Where-Object { @($rule['notificationRecipients']) -notcontains $_ }).Count -eq 0",
         "@{ notificationLevel = 'All'; isDefaultRecipientsEnabled = $true; notificationRecipients = @(@($rule['notificationRecipients']) + $NotifyAddress | Where-Object { $_ } | Sort-Object -Unique) }",
         params=[('NotifyAddress', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Email addresses to notify (security team mailbox).')],
         example="-NotifyAddress 'secops@contoso.com'")

for cid, role in (('ENTRA-PIM-004', GA), ('ENTRA-PIM-005', 'e8611ab8-c189-46e8-94e1-60213ab1f814')):
    name = TIER0[role]
    pim_rule(cid, 'Approval_EndUser_Assignment', f'Requires approval from the approvers you choose to activate {name}.',
             "$rule['setting']['isApprovalRequired'] -eq $true -and @($rule['setting']['approvalStages'][0]['primaryApprovers']).Count -gt 0",
             "@{ setting = @{ isApprovalRequired = $true; isApprovalRequiredForExtension = $false; isRequestorJustificationRequired = $true; approvalMode = 'SingleStage'; approvalStages = @(@{ approvalStageTimeOutInDays = 1; isApproverJustificationRequired = $true; escalationTimeInMinutes = 0; isEscalationEnabled = $false; primaryApprovers = $approvers; escalationApprovers = @() }) } }",
             roles={role: name}, label=name,
             params=[('ApproverGroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of groups whose members approve activation.'),
                     ('ApproverUserId', "[Parameter()]\n[string[]]", 'Object IDs of additional individual approvers.')],
             example="-ApproverGroupId '00000000-0000-0000-0000-000000000001'",
             prelude="$approvers = @(\n    @($ApproverUserId | Where-Object { $_ } | ForEach-Object { @{ '@odata.type' = '#microsoft.graph.singleUser'; userId = $_ } })\n    @($ApproverGroupId | Where-Object { $_ } | ForEach-Object { @{ '@odata.type' = '#microsoft.graph.groupMembers'; groupId = $_ } })\n)",
             notes='Approvers cannot approve their own requests. Keep at least two approvers, and make sure\nbreak-glass accounts hold the role permanently so approval cannot lock you out.')

# approvers prelude for PIM-004/005 (patched below by inserting into the generated script)

# ------------------------------------------------------------ role assignments
GA_FILTER = f"/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '{GA}'&`$expand=principal"
emit('ENTRA-ADMIN-001',
     desc='Brings the number of active Global Administrators to between two and four by adding and/or\nremoving the accounts you name.',
     desired='2-4 active Global Administrators',
     services=['Graph'], scopes=['RoleManagement.ReadWrite.Directory'],
     params=[('AddUserId', "[Parameter()]\n[string[]]", 'Object IDs of users to make Global Administrator (cloud-only accounts).'),
             ('RemoveUserId', "[Parameter()]\n[string[]]", 'Object IDs of users to remove from Global Administrator.')],
     notes='Prefer PIM eligible assignments over active ones (see ENTRA-PIM-001). Never remove the last\nworking Global Administrator or a break-glass account.',
     steps=[dict(target='Global Administrator active assignments', desired='2-4, with -AddUserId present and -RemoveUserId absent',
                 get=f"@(@((Invoke-MgGraphRequest -Method GET -Uri \"{GA_FILTER}\" -OutputType HashTable)['value']) | Where-Object {{ $_ }} |\n    ForEach-Object {{ [PSCustomObject]@{{ AssignmentId = $_['id']; PrincipalId = $_['principalId']; Name = $_['principal']['displayName'] }} }})",
                 test="$ids = @($State | ForEach-Object { $_.PrincipalId })\n$count = $ids.Count\n$count -ge 2 -and $count -le 4 -and @($AddUserId | Where-Object { $_ -and $ids -notcontains $_ }).Count -eq 0 -and @($RemoveUserId | Where-Object { $_ -and $ids -contains $_ }).Count -eq 0",
                 set=f"$ids = @($State | ForEach-Object {{ $_.PrincipalId }})\n$after = @($ids + @($AddUserId | Where-Object {{ $_ }}) | Where-Object {{ @($RemoveUserId) -notcontains $_ }} | Sort-Object -Unique)\nif ($after.Count -lt 1) {{ throw 'Refusing to remove every Global Administrator.' }}\nif ($after.Count -lt 2 -or $after.Count -gt 4) {{ Write-Warning \"After this change there will be $($after.Count) Global Administrators; the check wants 2-4.\" }}\nforeach ($id in @($AddUserId | Where-Object {{ $_ -and $ids -notcontains $_ }})) {{\n    Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleAssignments' -Method POST -Body @{{ principalId = $id; roleDefinitionId = '{GA}'; directoryScopeId = '/' }}\n}}\nforeach ($assignment in @($State | Where-Object {{ @($RemoveUserId) -contains $_.PrincipalId }})) {{\n    Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/roleManagement/directory/roleAssignments/$($assignment.AssignmentId)\" | Out-Null\n}}")])

ELIG_SC = ['RoleEligibilitySchedule.ReadWrite.Directory', 'RoleAssignmentSchedule.ReadWrite.Directory']
CONVERT = dict(
    target='Permanent active Global Administrator assignments (excluding break-glass)', desired='Converted to PIM eligible',
    get=f"@(@((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignmentSchedules?`$filter=roleDefinitionId eq '{GA}'\" -OutputType HashTable)['value']) |\n    Where-Object {{ $null -ne $_ -and $_['assignmentType'] -eq 'Assigned' -and @($BreakGlassAccountId) -notcontains $_['principalId'] -and $_['scheduleInfo']['expiration']['type'] -eq 'noExpiration' }} |\n    ForEach-Object {{ [PSCustomObject]@{{ PrincipalId = $_['principalId'] }} }})",
    test=EMPTY,
    set=f"$start = (Get-Date).ToUniversalTime().ToString('o')\nforeach ($item in $State) {{\n    Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleEligibilityScheduleRequests' -Method POST -Body @{{\n        action = 'adminAssign'; justification = 'M365-Assess remediation: convert permanent GA to eligible'; roleDefinitionId = '{GA}'; directoryScopeId = '/'; principalId = $item.PrincipalId\n        scheduleInfo = @{{ startDateTime = $start; expiration = @{{ type = 'afterDuration'; duration = \"P$($EligibleDays)D\" }} }}\n    }}\n    Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleAssignmentScheduleRequests' -Method POST -Body @{{\n        action = 'adminRemove'; justification = 'M365-Assess remediation: convert permanent GA to eligible'; roleDefinitionId = '{GA}'; directoryScopeId = '/'; principalId = $item.PrincipalId\n    }}\n}}")
CONV_PARAMS = [('BreakGlassAccountId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of break-glass accounts that keep permanent active Global Administrator.'),
               ('EligibleDays = 365', "[Parameter()]\n[ValidateRange(15, 365)]\n[int]", 'Length of the new eligible assignments in days.')]
emit('ENTRA-PIM-001',
     desc='Converts permanent active Global Administrator assignments into time-bound PIM eligible\nassignments, keeping your break-glass accounts permanent.',
     desired='Only break-glass accounts hold permanent active Global Administrator',
     services=['Graph'], scopes=ELIG_SC, params=CONV_PARAMS,
     example_args="-BreakGlassAccountId '00000000-0000-0000-0000-000000000001'",
     notes='Requires Entra ID P2. Converted admins must activate the role in PIM before admin work;\nconfigure activation rules (ENTRA-PIM-006/007/008) first.',
     steps=[CONVERT])
emit('ENTRA-PRIVREMOTE-001',
     desc='Makes privileged (Global Administrator) access require PIM activation with MFA and a\njustification, and converts permanent assignments to eligible (break-glass accounts excepted).',
     desired='GA activation requires MFA + justification; only break-glass accounts permanent',
     services=['Graph'], scopes=ELIG_SC + PIM_SC, params=CONV_PARAMS,
     example_args="-BreakGlassAccountId '00000000-0000-0000-0000-000000000001'",
     notes='Requires Entra ID P2.',
     steps=[dict(target='PIM activation rule for Global Administrator', desired='MFA and justification required',
                 get=f"Get-RemediationPimRule -RoleDefinitionId '{GA}' -RuleId 'Enablement_EndUser_Assignment'",
                 test="@($State['enabledRules']) -contains 'MultiFactorAuthentication' -and @($State['enabledRules']) -contains 'Justification'",
                 set="Set-RemediationPimRule -Current $State -Changes @{ enabledRules = @(@($State['enabledRules']) + 'MultiFactorAuthentication' + 'Justification' | Sort-Object -Unique) }"),
            CONVERT])

ALL_ROLES = {**TIER0, **TIER1}
emit('ENTRA-HYBRID-002',
     desc='Removes Tier-0 and Tier-1 Entra role assignments from accounts synced from on-premises AD,\nso an on-premises compromise cannot reach cloud admin rights.',
     desired='No synced account holds a Tier-0/1 role',
     services=['Graph'], scopes=['RoleManagement.ReadWrite.Directory', 'User.Read.All'],
     params=[role_param(ALL_ROLES, 'Tier-0 and Tier-1'),
             ('ExcludeUserId', "[Parameter()]\n[string[]]", 'Synced accounts to leave as they are.'),
             ('ConfirmReplacementAccounts', "[Parameter(Mandatory)]\n[switch]", 'Confirms that cloud-only replacement admin accounts exist and hold these roles, so removing\nthe synced accounts\' roles does not leave the role unstaffed.')],
     example_args='-ConfirmReplacementAccounts',
     notes='Only direct (active) assignments are removed. PIM eligible assignments for synced accounts\nare listed in Before as well and should be removed in PIM.',
     steps=[dict(target='Tier-0/1 role assignments held by synced accounts', desired='None',
                 get="@(foreach ($roleId in $RoleDefinitionId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'&`$expand=principal\" -OutputType HashTable)['value']) |\n        Where-Object { $null -ne $_ -and $_['principal']['onPremisesSyncEnabled'] -eq $true -and @($ExcludeUserId) -notcontains $_['principalId'] } |\n        ForEach-Object { [PSCustomObject]@{ AssignmentId = $_['id']; RoleDefinitionId = $roleId; PrincipalId = $_['principalId']; UserPrincipalName = $_['principal']['userPrincipalName'] } }\n})",
                 test=EMPTY,
                 set="foreach ($assignment in $State) {\n    Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/roleManagement/directory/roleAssignments/$($assignment.AssignmentId)\" | Out-Null\n}")])

emit('ENTRA-CLOUDADMIN-002',
     desc='Removes productivity licenses (the SKUs you list, such as E3/E5) from Global Administrator\naccounts so admin accounts have a minimal application footprint.',
     desired='No Global Administrator has the listed SKUs directly assigned',
     services=['Graph'], scopes=['User.ReadWrite.All', 'RoleManagement.Read.Directory'],
     params=[('SkuId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'SKU IDs to remove (from Get-MgSubscribedSku), e.g. the E3 / E5 SKUs.'),
             ('ExcludeUserId', "[Parameter()]\n[string[]]", 'Admins to leave as they are.')],
     example_args="-SkuId '06ebc4ee-1bb5-47dd-8120-11324bc54e06'",
     notes='Removing a license deletes the mailbox and OneDrive after the grace period if the account\nhas them. Licenses assigned through groups are not removed; take the admin out of the group.',
     steps=[dict(target='Global Administrators with productivity licenses', desired='None',
                 get=f"@(@((Invoke-MgGraphRequest -Method GET -Uri \"{GA_FILTER}\" -OutputType HashTable)['value']) | Where-Object {{ $null -ne $_ -and @($ExcludeUserId) -notcontains $_['principalId'] }} |\n    ForEach-Object {{\n        $user = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/users/$($_['principalId'])?`$select=id,userPrincipalName,licenseAssignmentStates\" -OutputType HashTable -ErrorAction SilentlyContinue\n        $direct = @($user['licenseAssignmentStates'] | Where-Object {{ $null -eq $_['assignedByGroup'] -and @($SkuId) -contains $_['skuId'] }} | ForEach-Object {{ $_['skuId'] }})\n        if ($direct.Count -gt 0) {{ [PSCustomObject]@{{ Id = $user['id']; UserPrincipalName = $user['userPrincipalName']; SkuIds = $direct }} }}\n    }})",
                 test=EMPTY,
                 set="foreach ($admin in $State) {\n    Set-RemediationGraphObject -Uri \"/v1.0/users/$($admin.Id)/assignLicense\" -Method POST -Body @{ addLicenses = @(); removeLicenses = @($admin.SkuIds) }\n}")])

emit('ENTRA-DISABLED-001',
     desc='Deletes disabled member accounts that have not signed in for the number of days you choose.\nDeleted users can be restored for 30 days.',
     desired='No disabled member accounts older than -InactiveDays',
     services=['Graph'], scopes=['User.ReadWrite.All', 'AuditLog.Read.All'],
     params=[('InactiveDays', "[Parameter(Mandatory)]\n[ValidateRange(30, 3650)]\n[int]", 'Only delete disabled accounts with no sign-in for at least this many days.'),
             ('ExcludeUserId', "[Parameter()]\n[string[]]", 'Accounts to keep (legal hold, audit, shared mailboxes).')],
     example_args='-InactiveDays 180',
     notes='This check is informational in the assessment. Deleting a user also removes their mailbox\nand OneDrive after the retention period unless they are on hold; place holds first.',
     steps=[dict(target='Disabled member accounts past -InactiveDays', desired='Deleted',
                 get="$cutoff = (Get-Date).ToUniversalTime().AddDays(-$InactiveDays)\n$uri = \"/v1.0/users?`$filter=accountEnabled eq false and userType eq 'Member'&`$select=id,userPrincipalName,signInActivity&`$top=999\"\n$found = [System.Collections.Generic.List[object]]::new()\nwhile ($uri) {\n    $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType HashTable\n    foreach ($u in @($page['value'])) {\n        if ($null -eq $u -or @($ExcludeUserId) -contains $u['id']) { continue }\n        $last = $u['signInActivity']['lastSignInDateTime']\n        if ($null -eq $last -or [datetime]$last -lt $cutoff) { $found.Add([PSCustomObject]@{ Id = $u['id']; UserPrincipalName = $u['userPrincipalName']; LastSignIn = $last }) }\n    }\n    $uri = $page['@odata.nextLink']\n}\n@($found)",
                 test=EMPTY,
                 set="foreach ($user in $State) {\n    Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/users/$($user.Id)\" | Out-Null\n}")])

emit('ENTRA-PERUSER-001',
     desc='Turns off legacy per-user MFA (Enabled / Enforced) for every user, leaving MFA to Conditional\nAccess.',
     desired='perUserMfaState = disabled for all users',
     services=['Graph'], scopes=['Policy.ReadWrite.AuthenticationMethod', 'User.Read.All'],
     params=[('ConfirmCaEnforcesMfa', "[Parameter(Mandatory)]\n[switch]", 'Confirms that Conditional Access (or security defaults) already requires MFA for these users.\nWithout that, turning per-user MFA off removes MFA.'),
             ('UserId', "[Parameter()]\n[string[]]", 'Limit to these users. Defaults to every user (one request per user).')],
     example_args='-ConfirmCaEnforcesMfa',
     notes='Uses the Graph beta authentication requirements endpoint. Enumerating every user is slow in\nlarge tenants; pass -UserId for a pilot.',
     steps=[dict(target='Users with per-user MFA enabled or enforced', desired='None',
                 get="$ids = if (@($UserId | Where-Object { $_ }).Count -gt 0) { @($UserId) } else {\n    $all = [System.Collections.Generic.List[string]]::new()\n    $uri = \"/v1.0/users?`$select=id&`$top=999\"\n    while ($uri) {\n        $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType HashTable\n        foreach ($u in @($page['value'])) { if ($u) { $all.Add($u['id']) } }\n        $uri = $page['@odata.nextLink']\n    }\n    @($all)\n}\n@(foreach ($id in $ids) {\n    $req = Invoke-MgGraphRequest -Method GET -Uri \"/beta/users/$id/authentication/requirements\" -OutputType HashTable\n    if ($req['perUserMfaState'] -and $req['perUserMfaState'] -ne 'disabled') { [PSCustomObject]@{ Id = $id; State = $req['perUserMfaState'] } }\n})",
                 test=EMPTY,
                 set="foreach ($user in $State) {\n    Set-RemediationGraphObject -Uri \"/beta/users/$($user.Id)/authentication/requirements\" -Body @{ perUserMfaState = 'disabled' }\n}")])

# ------------------------------------------------------------ access reviews, ToU, branding, monitoring
AR = '/v1.0/identityGovernance/accessReviews/definitions'
AR_SC = ['AccessReview.ReadWrite.All']
REVIEW_COMMON = ("$settings = @{\n    mailNotificationsEnabled        = $true\n    reminderNotificationsEnabled    = $true\n    justificationRequiredOnApproval = $true\n    defaultDecisionEnabled          = $true\n    defaultDecision                 = 'Deny'\n    instanceDurationInDays          = 14\n    autoApplyDecisionsEnabled       = $true\n    recommendationsEnabled          = $true\n    recurrence                      = @{\n        pattern = @{ type = 'absoluteMonthly'; interval = $IntervalMonths }\n        range   = @{ type = 'noEnd'; startDate = (Get-Date).ToString('yyyy-MM-dd') }\n    }\n}")
emit('ENTRA-PIM-002',
     desc='Creates a recurring access review of guest users in every Microsoft 365 group, reviewed by\nthe group owners (with fallback reviewers you name). Unreviewed guests are removed.',
     desired='A recurring guest access review exists',
     services=['Graph'], scopes=AR_SC,
     params=[('FallbackReviewerId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of users who review when a group has no owner.'),
             ("ReviewName = 'M365-Assess - Guest access review'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Display name of the review.'),
             ('IntervalMonths = 3', "[Parameter()]\n[ValidateSet(1, 3, 6, 12)]\n[int]", 'How often the review recurs, in months.')],
     example_args="-FallbackReviewerId '00000000-0000-0000-0000-000000000001'",
     notes='Requires Entra ID P2 or Entra ID Governance. Denied or unreviewed guests are removed from\nthe group automatically at the end of each review.',
     prelude=REVIEW_COMMON,
     steps=[dict(target='"Access review $ReviewName"', desired='Exists',
                 get=f"@((Invoke-MgGraphRequest -Method GET -Uri \"{AR}?`$filter=displayName eq '$($ReviewName.Replace(\"'\", \"''\"))'\" -OutputType HashTable)['value']) | Where-Object {{ $_ }} | Select-Object -First 1",
                 test='$null -ne $State',
                 set=f"$definition = @{{\n    displayName             = $ReviewName\n    descriptionForAdmins    = 'Recurring review of guest access to Microsoft 365 groups.'\n    descriptionForReviewers = 'Confirm each guest still needs access to this group.'\n    instanceEnumerationScope = @{{ '@odata.type' = '#microsoft.graph.accessReviewQueryScope'; query = \"/groups?`$filter=(groupTypes/any(c:c+eq+'Unified'))\"; queryType = 'MicrosoftGraph' }}\n    scope                   = @{{ '@odata.type' = '#microsoft.graph.accessReviewQueryScope'; query = \"./members/microsoft.graph.user/?`$count=true&`$filter=(userType eq 'Guest')\"; queryType = 'MicrosoftGraph' }}\n    reviewers               = @(@{{ query = './owners'; queryType = 'MicrosoftGraph' }})\n    fallbackReviewers       = @($FallbackReviewerId | ForEach-Object {{ @{{ query = \"/users/$_\"; queryType = 'MicrosoftGraph' }} }})\n    settings                = $settings\n}}\nSet-RemediationGraphObject -Uri '{AR}' -Method POST -Body $definition")])

emit('ENTRA-PIM-003',
     desc='Creates a recurring access review of everyone assigned the privileged roles you list (active\nand PIM eligible), reviewed by the reviewers you name.',
     desired='A recurring privileged role access review exists',
     services=['Graph'], scopes=AR_SC,
     params=[('ReviewerId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of reviewers (not the role holders themselves).'),
             (f"RoleDefinitionId = @('{GA}', 'e8611ab8-c189-46e8-94e1-60213ab1f814')", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Roles to review. Defaults to Global Administrator and Privileged Role Administrator.'),
             ('IntervalMonths = 3', "[Parameter()]\n[ValidateSet(1, 3, 6, 12)]\n[int]", 'How often the review recurs, in months.')],
     example_args="-ReviewerId '00000000-0000-0000-0000-000000000001'",
     notes='Requires Entra ID P2 or Entra ID Governance. One review is created per role.',
     prelude=REVIEW_COMMON,
     steps=[dict(target='Privileged role access reviews', desired='One per role',
                 get=f"@(foreach ($roleId in $RoleDefinitionId) {{\n    $name = \"M365-Assess - Role review $roleId\"\n    $existing = @((Invoke-MgGraphRequest -Method GET -Uri \"{AR}?`$filter=displayName eq '$name'\" -OutputType HashTable)['value']) | Where-Object {{ $_ }}\n    if ($existing.Count -eq 0) {{ $roleId }}\n}})",
                 test=EMPTY,
                 set=f"foreach ($roleId in $State) {{\n    $definition = @{{\n        displayName = \"M365-Assess - Role review $roleId\"\n        scope       = @{{ '@odata.type' = '#microsoft.graph.accessReviewQueryScope'; query = \"/roleManagement/directory/roleAssignmentScheduleInstances?`$expand=principal&`$filter=(isof(principal,'microsoft.graph.user') and roleDefinitionId eq '$roleId')\"; queryType = 'MicrosoftGraph' }}\n        reviewers   = @($ReviewerId | ForEach-Object {{ @{{ query = \"/users/$_\"; queryType = 'MicrosoftGraph' }} }})\n        settings    = $settings\n    }}\n    Set-RemediationGraphObject -Uri '{AR}' -Method POST -Body $definition\n}}")])

emit('ENTRA-TOU-001',
     desc='Creates a Terms of Use agreement from your PDF, requiring users to open it before accepting.',
     desired='A Terms of Use agreement with isViewingBeforeAcceptanceRequired = true exists',
     services=['Graph'], scopes=['Agreement.ReadWrite.All'],
     params=[('PdfPath', "[Parameter(Mandatory)]\n[ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]\n[string]", 'Path to the Terms of Use PDF.'),
             ("AgreementName = 'Terms of Use'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Display name of the agreement.'),
             ("Language = 'en'", "[Parameter()]\n[string]", 'Language code of the PDF.')],
     example_args="-PdfPath '.\\TermsOfUse.pdf'",
     notes='The agreement only takes effect once a Conditional Access policy requires it (grant control\n"Require terms of use"). Requires Entra ID P1.',
     steps=[dict(target='"Terms of Use agreement $AgreementName"', desired='Exists, viewing required',
                 get="@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identityGovernance/termsOfUse/agreements' -OutputType HashTable)['value']) | Where-Object { $null -ne $_ -and $_['displayName'] -eq $AgreementName } | Select-Object -First 1",
                 test="$null -ne $State -and $State['isViewingBeforeAcceptanceRequired'] -eq $true",
                 set="if ($null -ne $State) {\n    Set-RemediationGraphObject -Uri \"/v1.0/identityGovernance/termsOfUse/agreements/$($State['id'])\" -Body @{ isViewingBeforeAcceptanceRequired = $true }\n}\nelse {\n    $data = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $PdfPath).Path))\n    Set-RemediationGraphObject -Uri '/v1.0/identityGovernance/termsOfUse/agreements' -Method POST -Body @{\n        displayName                       = $AgreementName\n        isViewingBeforeAcceptanceRequired = $true\n        isPerDeviceAcceptanceRequired     = $false\n        file                              = @{ fileName = (Split-Path -Path $PdfPath -Leaf); language = $Language; isDefault = $true; fileData = @{ data = $data } }\n    }\n}")])

emit('ENTRA-SESSION-001',
     desc='Hides the "Stay signed in?" prompt on the Microsoft sign-in page (company branding).',
     desired='loginPageTextVisibilitySettings.hideKeepMeSignedIn = true',
     services=['Graph'], scopes=['OrganizationalBranding.ReadWrite.All', 'Organization.Read.All'],
     notes='Applies to the default company branding. Create default branding first if the tenant has\nnone (Entra admin center > Company branding); the step reports Failed until it exists.',
     steps=[dict(target='Default company branding', desired='KMSI hidden',
                 get="$orgId = @((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/organization?$select=id' -OutputType HashTable)['value'])[0]['id']\n$branding = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/organization/$orgId/branding\" -Headers @{ 'Accept-Language' = '0' } -OutputType HashTable\n$branding['orgId'] = $orgId\n$branding",
                 test="$State['loginPageTextVisibilitySettings']['hideKeepMeSignedIn'] -eq $true",
                 set="Invoke-MgGraphRequest -Method PATCH -Uri \"/v1.0/organization/$($State['orgId'])/branding\" -Headers @{ 'Accept-Language' = '0' } -ContentType 'application/json' -Body (@{ loginPageTextVisibilitySettings = @{ hideKeepMeSignedIn = $true } } | ConvertTo-Json -Depth 5) | Out-Null")])

cmdlet_props('ENTRA-ORGSETTING-004', service='ExchangeOnline', get="Get-OwaMailboxPolicy -Identity 'OwaMailboxPolicy-Default'",
             setcmd="Set-OwaMailboxPolicy -Identity 'OwaMailboxPolicy-Default'", target='Default OWA mailbox policy (Bookings)',
             expected={'BookingsMailboxCreationEnabled': False},
             desc='Stops users on the default Outlook on the web policy from creating shared Bookings pages.\nGive approved staff a separate OWA mailbox policy with BookingsMailboxCreationEnabled on.',
             notes='Existing shared booking pages keep working.')

emit('ENTRA-BREAKGLASS-002',
     desc='Sends Entra sign-in and audit logs to a Log Analytics workspace and, optionally, creates an\nalert that fires on any sign-in by a break-glass account.',
     desired='Diagnostic setting to Log Analytics (+ break-glass sign-in alert)',
     services=['Azure'],
     params=[('WorkspaceResourceId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string]", 'Resource ID of the Log Analytics workspace (/subscriptions/.../workspaces/<name>).'),
             ('BreakGlassUpn', "[Parameter()]\n[string[]]", 'User principal names of break-glass accounts to alert on.'),
             ('ActionGroupResourceId', "[Parameter()]\n[string]", 'Resource ID of the Azure Monitor action group the alert notifies (required with -BreakGlassUpn).'),
             ("SettingName = 'M365-Assess-EntraLogs'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the diagnostic setting and alert rule.')],
     example_args="-WorkspaceResourceId '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<ws>'",
     notes='Uses Azure Resource Manager (Invoke-AzRestMethod, Az.Accounts). Requires Entra ID P1/P2 for\nsign-in log export and Contributor on the workspace resource group. Log Analytics ingestion is billed.',
     prelude="$diagPath = \"/providers/microsoft.aadiam/diagnosticSettings/$SettingName`?api-version=2017-04-01\"\n$diagBody = @{ properties = @{ workspaceId = $WorkspaceResourceId; logs = @(\n    @{ category = 'SignInLogs'; enabled = $true }\n    @{ category = 'AuditLogs'; enabled = $true }\n    @{ category = 'NonInteractiveUserSignInLogs'; enabled = $true }\n) } } | ConvertTo-Json -Depth 6\n$rgId = ($WorkspaceResourceId -split '/providers/')[0]\n$alertPath = \"$rgId/providers/Microsoft.Insights/scheduledQueryRules/$SettingName-breakglass?api-version=2023-03-15-preview\"",
     steps=[dict(target='"Entra diagnostic setting $SettingName"', desired='Sign-in and audit logs to the workspace',
                 get="$response = Invoke-AzRestMethod -Method GET -Path $diagPath\nif ($response.StatusCode -eq 200) { $response.Content | ConvertFrom-Json } else { $null }",
                 test="$null -ne $State -and $State.properties.workspaceId -eq $WorkspaceResourceId -and @($State.properties.logs | Where-Object { $_.category -eq 'SignInLogs' -and $_.enabled }).Count -gt 0",
                 set="$r = Invoke-AzRestMethod -Method PUT -Path $diagPath -Payload $diagBody\nif ($r.StatusCode -ge 300) { throw \"ARM returned $($r.StatusCode): $($r.Content)\" }"),
            dict(target='"Break-glass sign-in alert $SettingName-breakglass"', desired='Exists when -BreakGlassUpn is set',
                 get="if (@($BreakGlassUpn | Where-Object { $_ }).Count -eq 0) { return 'not-requested' }\n$response = Invoke-AzRestMethod -Method GET -Path $alertPath\nif ($response.StatusCode -eq 200) { $response.Content | ConvertFrom-Json } else { $null }",
                 test="$State -eq 'not-requested' -or $null -ne $State",
                 set="if ([string]::IsNullOrWhiteSpace($ActionGroupResourceId)) { throw 'Pass -ActionGroupResourceId with -BreakGlassUpn.' }\n$upns = (@($BreakGlassUpn) | ForEach-Object { \"'$_'\" }) -join ','\n$alert = @{\n    location   = (Invoke-AzRestMethod -Method GET -Path \"$WorkspaceResourceId`?api-version=2022-10-01\").Content | ConvertFrom-Json | Select-Object -ExpandProperty location\n    properties = @{\n        displayName = 'Break-glass account sign-in'\n        severity = 0; enabled = $true; evaluationFrequency = 'PT5M'; windowSize = 'PT5M'\n        scopes = @($WorkspaceResourceId)\n        criteria = @{ allOf = @(@{ query = \"SigninLogs | where UserPrincipalName in~ ($upns)\"; timeAggregation = 'Count'; operator = 'GreaterThan'; threshold = 0 }) }\n        actions = @{ actionGroups = @($ActionGroupResourceId) }\n    }\n} | ConvertTo-Json -Depth 10\n$r = Invoke-AzRestMethod -Method PUT -Path $alertPath -Payload $alert\nif ($r.StatusCode -ge 300) { throw \"ARM returned $($r.StatusCode): $($r.Content)\" }")])

# ------------------------------------------------------------ CA templates
ca_emit('ENTRA-CA-001', name='M365-Assess - Block legacy authentication',
        desc='Creates a Conditional Access policy that blocks legacy authentication (Exchange ActiveSync\nand other legacy clients) for all users and apps.',
        notes='Check the sign-in logs (Client app = legacy) for accounts still using legacy protocols before\nenabling.',
        policy="""@{
    conditions    = @{
        clientAppTypes = @('exchangeActiveSync', 'other')
        applications   = @{ includeApplications = @('All') }
        """ + ca_users() + """
    }
    grantControls = @{ operator = 'OR'; builtInControls = @('block') }
}""")
ca_emit('ENTRA-ADMIN-004', name='M365-Assess - Phishing-resistant MFA for Global Administrators',
        desc='Creates a Conditional Access policy requiring phishing-resistant MFA (FIDO2, Windows Hello\nfor Business, or certificate-based) for Global Administrators.',
        notes='Every Global Administrator must register a phishing-resistant method before you enable this,\nor they will be locked out. Break-glass accounts are excluded.',
        policy=f"""@{{
    conditions    = @{{
        clientAppTypes = @('all')
        applications   = @{{ includeApplications = @('All') }}
        """ + ca_users(roles=f"@('{GA}')") + """
    }
    grantControls = @{ operator = 'OR'; authenticationStrength = @{ id = '00000000-0000-0000-0000-000000000004' } }
}""")

emit('ENTRA-CONSENT-004',
     desc='Revokes tenant-wide (all users) delegated permission grants for the applications you name.\nUse after reviewing which admin-consented apps no longer need access for everyone.',
     desired='No AllPrincipals grants for -ServicePrincipalId',
     services=['Graph'], scopes=['DelegatedPermissionGrant.ReadWrite.All'],
     params=[('ServicePrincipalId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of the enterprise applications (service principals) whose tenant-wide grants to revoke.')],
     example_args="-ServicePrincipalId '00000000-0000-0000-0000-000000000001'",
     notes='Revoking a grant stops the app from acting on behalf of every user; users can be prompted\nfor consent again if user consent is allowed. Each removed grant (client, resource, scopes) is\nreturned in Before so it can be recreated.',
     steps=[dict(target='Tenant-wide delegated grants for the listed apps', desired='Revoked',
                 get="@(foreach ($sp in $ServicePrincipalId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$sp' and consentType eq 'AllPrincipals'\" -OutputType HashTable)['value']) |\n        Where-Object { $_ } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; ClientId = $_['clientId']; ResourceId = $_['resourceId']; Scope = $_['scope'] } }\n})",
                 test=EMPTY,
                 set="foreach ($grant in $State) {\n    Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/oauth2PermissionGrants/$($grant.Id)\" | Out-Null\n}")])
print('ok')
