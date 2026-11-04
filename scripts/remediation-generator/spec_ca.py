from gen import emit, ca_emit, ca_users, CA_SCOPES

EMPTY = '$null -eq $State -or @($State).Count -eq 0'
ADMIN_ROLES = ['62e90394-69f5-4237-9190-012177145e10', 'e8611ab8-c189-46e8-94e1-60213ab1f814', 'fe930be7-5e62-47db-91af-98c3a49a38b1',
               'f28a1f50-f6e7-4571-818b-6a12f2af6b6c', '29232cdf-9323-42fd-ade2-1d097af3e4de', 'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9',
               '194ae4cb-b126-40b2-bd5b-6091b380977d', '729827e3-9c14-49f7-bb1b-9608f156bbb8', '966707d0-3269-4727-9be2-8c3a10f19b9d',
               'fdd7a751-b60b-444a-984c-02652fe8fa1c', '11648597-926c-4cf3-9c36-bcebb0ba8dcc', '3a2c62db-5318-420d-8d74-23affee5d9d5',
               '158c047a-c907-4556-b7ef-446551a6b5f7', '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', '7be44c8a-adaf-4e2a-84d6-ab2649e08a13',
               'c4e39bd9-1100-46d3-8c65-fb160da0071f', 'b0f54661-2d74-4c50-afa3-1ec803f12efe', '44367163-eba1-44c3-98af-f5787879f96a',
               '8835291a-918c-4fd7-a9ce-faa49f0cf7d9', '112f9a7f-7249-4951-bd88-c42b60cebe72']
ROLES_PS = "@(\n    " + ",\n    ".join(f"'{r}'" for r in ADMIN_ROLES) + "\n)"
ROLE_PARAM = (f"AdminRoleId = {ROLES_PS}", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string[]]",
              'Directory role template IDs the policy targets. Defaults to the admin roles the assessment\nchecks (Global, Privileged Role, Security, Exchange, SharePoint, and other administrators).')
ALL_APPS = "applications   = @{ includeApplications = @('All') }"
ADMIN_USERS = ca_users(roles='@($AdminRoleId)')
EVERYTIME = "sessionControls = @{ signInFrequency = @{ isEnabled = $true; frequencyInterval = 'everyTime'; authenticationType = 'primaryAndSecondaryAuthentication' } }"
DEVICE_GRANT = "@{ operator = 'OR'; builtInControls = @('compliantDevice', 'domainJoinedDevice') }"


def pol(conditions, grant=None, session=None):
    body = "@{\n    conditions    = @{\n        clientAppTypes = @('all')\n        " + conditions + "\n    }"
    if grant:
        body += f"\n    grantControls = {grant}"
    if session:
        body += f"\n    {session}"
    return body + "\n}"


LEGACY = pol(ALL_APPS + "\n        " + ca_users(), "@{ operator = 'OR'; builtInControls = @('block') }").replace("clientAppTypes = @('all')", "clientAppTypes = @('exchangeActiveSync', 'other')")
for cid in ('CA-LEGACYAUTH-001', 'ENTRA-SESSIONAUTH-001'):
    ca_emit(cid, name='M365-Assess - Block legacy authentication', policy=LEGACY,
            desc='Creates a Conditional Access policy that blocks legacy authentication (Exchange ActiveSync and\nother legacy clients) for all users and apps.',
            notes='If security defaults are on, turn them off when enabling this (CA and security defaults cannot\nboth be active). Check sign-in logs for legacy clients first.')

ca_emit('CA-MFA-ALL-001', name='M365-Assess - Require MFA for all users',
        policy=pol(ALL_APPS + "\n        " + ca_users(), "@{ operator = 'OR'; builtInControls = @('mfa') }"),
        desc='Creates a Conditional Access policy requiring MFA for all users on all cloud apps.',
        notes='Service accounts that cannot do MFA must be excluded (use -ExcludeGroupId) and moved to\nworkload identities. Turn off security defaults when enabling.')
ca_emit('CA-MFA-ADMIN-001', name='M365-Assess - Require MFA for administrators', params=[ROLE_PARAM],
        policy=pol(ALL_APPS + "\n        " + ADMIN_USERS, "@{ operator = 'OR'; builtInControls = @('mfa') }"),
        desc='Creates a Conditional Access policy requiring MFA for every administrative directory role.')
ca_emit('CA-PHISHRES-001', name='M365-Assess - Phishing-resistant MFA for administrators', params=[ROLE_PARAM],
        policy=pol(ALL_APPS + "\n        " + ADMIN_USERS, "@{ operator = 'OR'; authenticationStrength = @{ id = '00000000-0000-0000-0000-000000000004' } }"),
        desc='Creates a Conditional Access policy requiring the built-in phishing-resistant MFA\nauthentication strength (FIDO2, Windows Hello for Business, certificate) for administrators.',
        notes='Every admin needs a phishing-resistant method registered before you enable this.')
ca_emit('CA-ROLECOVERAGE-001', name='M365-Assess - Privileged role coverage', params=[ROLE_PARAM,
        ("Control = 'Mfa'", "[Parameter()]\n[ValidateSet('Mfa', 'PhishingResistant')]\n[string]", 'Grant control for the role-targeted policy.')],
        extra_prelude="$grant = if ($Control -eq 'Mfa') { @{ operator = 'OR'; builtInControls = @('mfa') } } else { @{ operator = 'OR'; authenticationStrength = @{ id = '00000000-0000-0000-0000-000000000004' } } }",
        policy=pol(ALL_APPS + "\n        " + ADMIN_USERS, '$grant'),
        desc='Creates a Conditional Access policy that explicitly targets every privileged directory role,\nso newly activated Tier-0 roles are covered.')

FREQ = "@{ signInFrequency = @{ isEnabled = $true; type = 'hours'; value = $Hours; frequencyInterval = 'timeBased'; authenticationType = 'primaryAndSecondaryAuthentication' }; persistentBrowser = @{ isEnabled = $true; mode = 'never' } }"
ca_emit('CA-SIGNIN-FREQ-001', name='M365-Assess - Admin sign-in frequency', params=[ROLE_PARAM,
        ('Hours = 4', "[Parameter()]\n[ValidateRange(1, 24)]\n[int]", 'Re-authentication interval in hours for administrators.')],
        policy=pol(ALL_APPS + "\n        " + ADMIN_USERS, session=f"sessionControls = {FREQ}"),
        desc='Creates a Conditional Access policy that makes administrators re-authenticate every few hours\nand never keeps their browser sessions persistent.')
ca_emit('ENTRA-CA-SESSIONFREQ-001', name='M365-Assess - Session sign-in frequency',
        params=[('Hours = 8', "[Parameter()]\n[ValidateRange(1, 24)]\n[int]", 'Re-authentication interval in hours.')],
        policy=pol(ALL_APPS + "\n        " + ca_users(), session=f"sessionControls = {FREQ}"),
        desc='Creates a Conditional Access policy enforcing a sign-in frequency for all users and turning off\npersistent browser sessions.',
        notes='Users re-authenticate every -Hours on every device. Consider scoping to unmanaged devices with a\ndevice filter if this is too disruptive.')

ca_emit('CA-DEVICE-001', name='M365-Assess - Require managed device',
        policy=pol(ALL_APPS + "\n        " + ca_users(), DEVICE_GRANT),
        desc='Creates a Conditional Access policy requiring a compliant or hybrid-joined device for all users\nand apps.',
        notes='Users on personal devices lose access. Mobile users need Intune enrollment (or use an app\nprotection policy for mobile instead).')
ca_emit('CA-DEVICE-002', name='M365-Assess - Managed device for security info registration',
        policy=pol("applications   = @{ includeUserActions = @('urn:user:registersecurityinfo') }\n        " + ca_users(), DEVICE_GRANT),
        desc='Creates a Conditional Access policy requiring a compliant or hybrid-joined device to register\nsecurity information (MFA methods, SSPR).',
        notes='New hires without a managed device yet cannot register MFA; issue them a Temporary Access Pass\nor exclude an onboarding group.')
ca_emit('CA-REMOTEDEVICE-001', name='M365-Assess - Compliant device for remote access',
        params=[("ExcludeLocationId = @('AllTrusted')", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string[]]", "Named locations treated as on-premises (excluded). Defaults to all trusted locations.")],
        policy=pol(ALL_APPS + "\n        " + ca_users() + "\n        locations      = @{ includeLocations = @('All'); excludeLocations = @($ExcludeLocationId) }",
                   "@{ operator = 'OR'; builtInControls = @('compliantDevice') }"),
        desc='Creates a Conditional Access policy requiring an Intune-compliant device for access from outside\nyour trusted named locations.')
ca_emit('CA-DEVICECODE-001', name='M365-Assess - Block device code flow',
        policy=pol(ALL_APPS + "\n        " + ca_users() + "\n        authenticationFlows = @{ transferMethods = 'deviceCodeFlow' }",
                   "@{ operator = 'OR'; builtInControls = @('block') }"),
        desc='Creates a Conditional Access policy that blocks the device code authentication flow.',
        notes='Teams Rooms, some meeting devices and CLI tools use device code. Exclude their accounts with\n-ExcludeGroupId.')
ca_emit('CA-INTUNE-001', name='M365-Assess - Intune enrollment sign-in every time',
        policy=pol("applications   = @{ includeApplications = @('d4ebce55-015a-49b5-a083-c84d1797ae8c') }\n        " + ca_users(),
                   "@{ operator = 'OR'; builtInControls = @('mfa') }", EVERYTIME),
        desc='Creates a Conditional Access policy that requires MFA and a fresh sign-in every time a device is\nenrolled in Intune.',
        notes="The assessment check reads signInFrequency.type = 'everyTime'; Graph stores this as\nfrequencyInterval = 'everyTime', so the check may not recognize the policy until the collector\nis updated.")

RISK_CONTROL = ("Control = 'Mfa'", "[Parameter()]\n[ValidateSet('Mfa', 'Block')]\n[string]", 'Mfa: require MFA (with sign-in every time). Block: block risky sign-ins.')
RISK_GRANT = ("$grant = if ($Control -eq 'Mfa') { @{ operator = 'OR'; builtInControls = @('mfa') } } else { @{ operator = 'OR'; builtInControls = @('block') } }\n"
              "$session = if ($Control -eq 'Mfa') { @{ signInFrequency = @{ isEnabled = $true; frequencyInterval = 'everyTime'; authenticationType = 'primaryAndSecondaryAuthentication' } } } else { $null }")
for cid, default in (('CA-SIGNINRISK-001', 'Mfa'), ('CA-SIGNINRISK-002', 'Block')):
    ca_emit(cid, name=f'M365-Assess - Sign-in risk {default.lower()}',
            params=[(f"Control = '{default}'",) + RISK_CONTROL[1:]],
            extra_prelude=RISK_GRANT,
            policy=pol(ALL_APPS + "\n        " + ca_users() + "\n        signInRiskLevels = @('high', 'medium')", '$grant') + "\nif ($null -ne $session) { $policy['sessionControls'] = $session }",
            desc='Creates a Conditional Access policy acting on medium and high sign-in risk (Identity Protection).',
            notes='Requires Entra ID P2.')
ca_emit('CA-USERRISK-001', name='M365-Assess - User risk password change',
        policy=pol(ALL_APPS + "\n        " + ca_users() + "\n        userRiskLevels = @('high')",
                   "@{ operator = 'AND'; builtInControls = @('mfa', 'passwordChange') }", EVERYTIME),
        desc='Creates a Conditional Access policy requiring MFA and a secure password change when user risk is\nhigh (Identity Protection).',
        notes='Requires Entra ID P2. Users need SSPR (and password writeback for hybrid accounts) to complete\nthe password change.')

# ------------------------------------------------------------ per-object CA fixes
CA_LIST = "@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $_ }"
PATCH = "Invoke-MgGraphRequest -Method PATCH -Uri \"/v1.0/identity/conditionalAccess/policies/$($p.Id)\" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 20) | Out-Null"

emit('CA-REPORTONLY-001',
     desc='Promotes the report-only Conditional Access policies you name to enforced, or turns them off.',
     desired='Listed policies are no longer report-only', services=['Graph'], scopes=CA_SCOPES,
     params=[('PolicyId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'IDs of the report-only policies to change.'),
             ('Action', "[Parameter(Mandatory)]\n[ValidateSet('Enable', 'Disable')]\n[string]", 'Enable: enforce the policy. Disable: turn it off.')],
     example_args="-PolicyId '00000000-0000-0000-0000-000000000001' -Action Enable",
     notes='Review each policy\'s report-only results (CA insights workbook) before enabling.',
     steps=[dict(target='Listed report-only policies', desired='"$Action"',
                 get=f"@({CA_LIST} | Where-Object {{ @($PolicyId) -contains $_['id'] -and $_['state'] -eq 'enabledForReportingButNotEnforced' }} |\n    ForEach-Object {{ [PSCustomObject]@{{ Id = $_['id']; DisplayName = $_['displayName'] }} }})",
                 test=EMPTY,
                 set="$newState = if ($Action -eq 'Enable') { 'enabled' } else { 'disabled' }\nforeach ($p in $State) {\n    $patch = @{ state = $newState }\n    " + PATCH + "\n}")])

emit('CA-SESSION-001',
     desc='Fixes policies that keep browser sessions persistent without requiring a managed device: sets\npersistent browser to never, or adds a compliant-device requirement.',
     desired='No persistent-browser policy without device compliance', services=['Graph'], scopes=CA_SCOPES,
     params=[('Action', "[Parameter(Mandatory)]\n[ValidateSet('NeverPersist', 'RequireCompliantDevice')]\n[string]",
              'NeverPersist: change persistent browser to Never. RequireCompliantDevice: keep persistence but\nadd compliant / hybrid-joined device to the grant (AND).'),
             ('PolicyId', "[Parameter()]\n[string[]]", 'Limit to these policies. Defaults to every enabled policy that matches the finding.')],
     example_args='-Action NeverPersist',
     steps=[dict(target='Persistent-browser policies without device compliance', desired='"Fixed by $Action"',
                 get=f"@({CA_LIST} | Where-Object {{\n    $_['state'] -eq 'enabled' -and $_['sessionControls'] -and $_['sessionControls']['persistentBrowser'] -and\n    $_['sessionControls']['persistentBrowser']['mode'] -eq 'always' -and $_['sessionControls']['persistentBrowser']['isEnabled'] -eq $true -and\n    -not (@($_['grantControls']['builtInControls']) -contains 'compliantDevice' -or @($_['grantControls']['builtInControls']) -contains 'domainJoinedDevice') -and\n    (@($PolicyId | Where-Object {{ $_ }}).Count -eq 0 -or @($PolicyId) -contains $_['id'])\n}} | ForEach-Object {{ [PSCustomObject]@{{ Id = $_['id']; DisplayName = $_['displayName']; Grant = $_['grantControls'] }} }})",
                 test=EMPTY,
                 set="foreach ($p in $State) {\n    if ($Action -eq 'NeverPersist') {\n        $patch = @{ sessionControls = @{ persistentBrowser = @{ isEnabled = $true; mode = 'never' } } }\n    }\n    else {\n        $controls = @(@($p.Grant['builtInControls']) + 'compliantDevice' | Where-Object { $_ } | Sort-Object -Unique)\n        $patch = @{ grantControls = @{ operator = 'AND'; builtInControls = $controls } }\n    }\n    " + PATCH + "\n}")])

emit('CA-RISKPOLICY-001',
     desc='Splits Conditional Access policies that combine sign-in risk and user risk (an AND condition that\nrarely triggers) into two policies, one per risk type, and turns the original off.',
     desired='No enabled policy combines sign-in and user risk', services=['Graph'], scopes=CA_SCOPES,
     params=[('PolicyId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'IDs of the combined-risk policies to split.')],
     example_args="-PolicyId '00000000-0000-0000-0000-000000000001'",
     notes='The two new policies copy the original\'s users, apps, and controls and are created in\nreport-only mode; enable them after review. The original is set to disabled, not deleted.',
     steps=[dict(target='Listed combined-risk policies', desired='Split into separate policies',
                 get=f"@({CA_LIST} | Where-Object {{\n    @($PolicyId) -contains $_['id'] -and $_['state'] -eq 'enabled' -and @($_['conditions']['signInRiskLevels']).Count -gt 0 -and @($_['conditions']['userRiskLevels']).Count -gt 0\n}})",
                 test=EMPTY,
                 set="foreach ($original in $State) {\n    foreach ($kind in @('signIn', 'user')) {\n        $copy = $original | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable\n        foreach ($key in @('id', 'createdDateTime', 'modifiedDateTime', 'templateId', '@odata.context')) { $copy.Remove($key) }\n        $copy['displayName'] = \"$($original['displayName']) ($kind risk)\"\n        $copy['state'] = 'enabledForReportingButNotEnforced'\n        if ($kind -eq 'signIn') { $copy['conditions']['userRiskLevels'] = @() } else { $copy['conditions']['signInRiskLevels'] = @() }\n        Invoke-MgGraphRequest -Method POST -Uri '/v1.0/identity/conditionalAccess/policies' -ContentType 'application/json' -Body ($copy | ConvertTo-Json -Depth 20) | Out-Null\n    }\n    $p = [PSCustomObject]@{ Id = $original['id'] }\n    $patch = @{ state = 'disabled' }\n    " + PATCH + "\n}")])

emit('CA-FALLBACK-001',
     desc='Fixes enabled Conditional Access policies whose include targets resolve to nobody: turns them off,\nor points them at the group you name.',
     desired='Every enabled policy targets someone', services=['Graph'], scopes=CA_SCOPES,
     params=[('Action', "[Parameter(Mandatory)]\n[ValidateSet('Disable', 'IncludeGroup')]\n[string]", 'Disable the policies, or set their include target to -IncludeGroupId.'),
             ('IncludeGroupId', "[Parameter()]\n[string[]]", 'Groups to include when -Action IncludeGroup is used.')],
     example_args='-Action Disable',
     steps=[dict(target='Enabled policies with empty include targets', desired='"Fixed by $Action"',
                 get=f"@({CA_LIST} | Where-Object {{\n    $u = $_['conditions']['users']\n    $_['state'] -eq 'enabled' -and\n    ((-not $u['includeUsers']) -or @($u['includeUsers']).Count -eq 0 -or @($u['includeUsers']) -contains 'None') -and\n    @($u['includeGroups']).Count -eq 0 -and @($u['includeRoles']).Count -eq 0\n}} | ForEach-Object {{ [PSCustomObject]@{{ Id = $_['id']; DisplayName = $_['displayName']; Users = $_['conditions']['users'] }} }})",
                 test=EMPTY,
                 set="if ($Action -eq 'IncludeGroup' -and @($IncludeGroupId | Where-Object { $_ }).Count -eq 0) { throw 'Pass -IncludeGroupId with -Action IncludeGroup.' }\nforeach ($p in $State) {\n    if ($Action -eq 'Disable') {\n        $patch = @{ state = 'disabled' }\n    }\n    else {\n        $users = @{}\n        foreach ($k in $p.Users.Keys) { $users[$k] = $p.Users[$k] }\n        $users['includeUsers'] = @()\n        $users['includeGroups'] = @($IncludeGroupId)\n        $patch = @{ conditions = @{ users = $users } }\n    }\n    " + PATCH + "\n}")])

emit('CA-NAMEDLOC-001',
     desc='Removes the "trusted" flag from the IP-based named locations you name, so policies stop treating\nthose IP ranges as inherently safe.',
     desired='Listed IP named locations not trusted', services=['Graph'], scopes=CA_SCOPES,
     params=[('NamedLocationId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'IDs of the IP named locations to untrust.')],
     example_args="-NamedLocationId '00000000-0000-0000-0000-000000000001'",
     notes='Policies that exclude "All trusted locations" will start applying on those networks (for\nexample MFA from the office). Consider Global Secure Access compliant network instead.',
     steps=[dict(target='Listed trusted IP named locations', desired='Not trusted',
                 get="@(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/namedLocations' -OutputType HashTable)['value']) | Where-Object {\n    $null -ne $_ -and @($NamedLocationId) -contains $_['id'] -and $_['@odata.type'] -eq '#microsoft.graph.ipNamedLocation' -and $_['isTrusted'] -eq $true\n} | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName'] } })",
                 test=EMPTY,
                 set="foreach ($location in $State) {\n    Set-RemediationGraphObject -Uri \"/v1.0/identity/conditionalAccess/namedLocations/$($location.Id)\" -Body @{ '@odata.type' = '#microsoft.graph.ipNamedLocation'; isTrusted = $false }\n}")])

STALE_FIX = ("foreach ($p in $State) {\n    $section = $p.Conditions\n    # Send the whole section so no other user/location condition is dropped.\n    $copy = @{}\n    foreach ($k in $section.Keys) { $copy[$k] = $section[$k] }\n    $patch = @{ conditions = @{ KEY = $copy } }\n    $skip = $false\n    foreach ($field in FIELDS) {\n        $kept = @($section[$field] | Where-Object { $_ -and @($p.Stale) -notcontains $_ })\n        if ($field -like 'include*' -and @($section[$field]).Count -gt 0 -and $kept.Count -eq 0 -and INCLUDE_EMPTY) {\n            Write-Warning \"Skipping $($p.DisplayName): removing the stale $field entries would leave it with no include target. Fix it manually or with CA-FALLBACK-001.\"\n            $skip = $true\n        }\n        $patch['conditions']['KEY'][$field] = $kept\n    }\n    if (-not $skip) { " + PATCH + " }\n}")
emit('CA-NAMEDLOC-002',
     desc='Removes references to deleted named locations from Conditional Access policies.',
     desired='No policy references a missing named location', services=['Graph'], scopes=CA_SCOPES,
     notes='A policy whose only included location is stale is skipped (removing it would widen the policy)\nand reported, so it is fixed by hand.',
     prelude="$known = @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/namedLocations' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object { $_['id'] }) + @('All', 'AllTrusted', '00000000-0000-0000-0000-000000000000')" if False else '',
     steps=[dict(target='Policies referencing deleted named locations', desired='References removed',
                 get="$known = @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/namedLocations' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object { $_['id'] }) + @('All', 'AllTrusted', '00000000-0000-0000-0000-000000000000')\n"
                     f"@({CA_LIST} | ForEach-Object {{\n    $loc = $_['conditions']['locations']\n    if ($loc) {{\n        $stale = @(@($loc['includeLocations']) + @($loc['excludeLocations']) | Where-Object {{ $_ -and $known -notcontains $_ }})\n        if ($stale.Count -gt 0) {{ [PSCustomObject]@{{ Id = $_['id']; DisplayName = $_['displayName']; Conditions = $loc; Stale = $stale }} }}\n    }}\n}})",
                 test=EMPTY,
                 set=STALE_FIX.replace('KEY', 'locations').replace('FIELDS', "@('includeLocations', 'excludeLocations')").replace('INCLUDE_EMPTY', '$true'))])
emit('CA-STALEREF-001',
     desc='Removes references to deleted groups from Conditional Access policy include and exclude lists.',
     desired='No policy references a deleted group', services=['Graph'], scopes=CA_SCOPES + ['Group.Read.All'],
     notes='A policy whose only include target is a deleted group is skipped and reported (removing it would\nleave the policy targeting nobody).',
     steps=[dict(target='Policies referencing deleted groups', desired='References removed',
                 get=f"@({CA_LIST} | ForEach-Object {{\n    $users = $_['conditions']['users']\n    $refs = @(@($users['includeGroups']) + @($users['excludeGroups']) | Where-Object {{ $_ }} | Sort-Object -Unique)\n    $stale = @($refs | Where-Object {{\n        $id = $_\n        try {{ $null = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups/$id`?`$select=id\" -ErrorAction Stop; $false }} catch {{ \"$($_.Exception.Message)\" -match '404|NotFound|does not exist' }}\n    }})\n    if ($stale.Count -gt 0) {{ [PSCustomObject]@{{ Id = $_['id']; DisplayName = $_['displayName']; Conditions = $users; Stale = $stale }} }}\n}})",
                 test=EMPTY,
                 set=STALE_FIX.replace('KEY', 'users').replace('FIELDS', "@('includeGroups', 'excludeGroups')").replace('INCLUDE_EMPTY', "@($section['includeUsers'] | Where-Object { $_ -and $_ -ne 'None' }).Count -eq 0 -and @($section['includeRoles']).Count -eq 0"))])
print('ok')
