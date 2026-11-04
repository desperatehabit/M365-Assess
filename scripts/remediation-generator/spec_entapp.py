from gen import emit, graph_props

APP_SC = ['Application.ReadWrite.All']
EMPTY = '$null -eq $State -or @($State).Count -eq 0'
APPID = lambda req=True: ('ApplicationObjectId', ("[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]" if req else "[Parameter()]\n[string[]]"),
                          'Object IDs of the app registrations to change (App registrations > Overview > Object ID).' + ('' if req else '\nDefaults to every app registration.'))
SPID = ('ServicePrincipalId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]",
        'Object IDs of the enterprise applications (service principals) to change, from the assessment\nfinding or Enterprise applications > Properties > Object ID.')
EX_APP = "-ApplicationObjectId '00000000-0000-0000-0000-000000000001'"
EX_SP = "-ServicePrincipalId '00000000-0000-0000-0000-000000000001'"

# ------------------------------------------------------------ redirect URIs
REDIRECT = {
    'ENTRA-APPREG-002': ("'localhost|127\\.0\\.0\\.1|\\[::1\\]'", 'localhost / loopback', 'Removes localhost and loopback redirect URIs from the production app registrations you name.'),
    'ENTRA-APPREG-003': ("'^http://(?!localhost|127\\.0\\.0\\.1)'", 'plain-HTTP', 'Replaces plain-HTTP redirect URIs with their HTTPS equivalents (or removes them) on the app\nregistrations you name.'),
    'ENTRA-APPREG-004': ("'\\*'", 'wildcard', 'Removes wildcard redirect URIs from the app registrations you name. Add the explicit URIs the\napp needs with -ReplacementUri.'),
}
for cid, (pattern, label, desc) in REDIRECT.items():
    params = [APPID()]
    if cid == 'ENTRA-APPREG-003':
        params.append(("Action = 'UpgradeToHttps'", "[Parameter()]\n[ValidateSet('UpgradeToHttps', 'Remove')]\n[string]", 'UpgradeToHttps (default) rewrites http:// to https://; Remove deletes the URI.'))
    if cid == 'ENTRA-APPREG-004':
        params.append(('ReplacementUri', "[Parameter()]\n[string[]]", 'Explicit redirect URIs to add to the web platform in place of the wildcards.'))
    rewrite = ("if ($Action -eq 'UpgradeToHttps') { @($uris | ForEach-Object { if ($_ -match $pattern) { $_ -replace '^http://', 'https://' } else { $_ } }) } else { @($uris | Where-Object { $_ -notmatch $pattern }) }"
               if cid == 'ENTRA-APPREG-003' else "@($uris | Where-Object { $_ -notmatch $pattern })")
    extra = "\n    if ($platform -eq 'web' -and @($ReplacementUri | Where-Object { $_ }).Count -gt 0) { $new = @($new + $ReplacementUri | Sort-Object -Unique) }" if cid == 'ENTRA-APPREG-004' else ''
    emit(cid, desc=desc, desired=f'No {label} redirect URIs on the listed apps', services=['Graph'], scopes=APP_SC, params=params,
         example_args=EX_APP,
         notes='Developers who sign in to these apps from a local machine need a separate development app\nregistration. The original URIs are returned in Before.',
         prelude=f"$pattern = {pattern}",
         steps=[dict(target=f'"{label} redirect URIs on $(@($ApplicationObjectId).Count) app(s)"', desired='Removed',
                     get="@(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {\n    $app = $_\n    foreach ($platform in @('web', 'spa', 'publicClient')) {\n        $bad = @($app[$platform]['redirectUris'] | Where-Object { $_ -match $pattern })\n        if ($bad.Count -gt 0) { [PSCustomObject]@{ Id = $app['id']; DisplayName = $app['displayName']; Platform = $platform; Uris = @($app[$platform]['redirectUris']); Matching = $bad } }\n    }\n})",
                     test=EMPTY,
                     set=f"foreach ($finding in $State) {{\n    $platform = $finding.Platform\n    $uris = $finding.Uris\n    $new = {rewrite}{extra}\n    $current = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/applications/$($finding.Id)?`$select=$platform\" -OutputType HashTable\n    $block = @{{}}\n    foreach ($key in $current[$platform].Keys) {{ if ($key -ne 'redirectUriSettings') {{ $block[$key] = $current[$platform][$key] }} }}\n    $block['redirectUris'] = $new\n    Set-RemediationGraphObject -Uri \"/v1.0/applications/$($finding.Id)\" -Body @{{ $platform = $block }}\n}}")])

# ------------------------------------------------------------ credentials
CRED_ROW = "[PSCustomObject]@{ Id = $app['id']; DisplayName = $app['displayName']; Secrets = SECRETS; Certificates = CERTS }"


def cred(cid, desc, select_secrets, select_certs, condition, params, notes, example=EX_APP, extra_desired='Removed'):
    row = CRED_ROW.replace('SECRETS', select_secrets).replace('CERTS', select_certs)
    emit(cid, desc=desc, desired=extra_desired, services=['Graph'], scopes=APP_SC, params=params, example_args=example, notes=notes,
         prelude="$now = (Get-Date).ToUniversalTime()" if '$now' in select_secrets + select_certs else '',
         steps=[dict(target='App registration credentials', desired=extra_desired,
                     get=f"@(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {{\n    $app = $_\n    $row = {row}\n    if ({condition}) {{ $row }}\n}})",
                     test=EMPTY,
                     set="foreach ($finding in $State) {\n    Remove-RemediationAppCredential -ObjectId $finding.Id -SecretKeyId @($finding.Secrets) -CertificateKeyId @($finding.Certificates)\n}")])


ALL_SECRETS = "@($app['passwordCredentials'] | Where-Object { $_ } | ForEach-Object { \"$($_['keyId'])\" })"
ALL_CERTS = "@($app['keyCredentials'] | Where-Object { $_ } | ForEach-Object { \"$($_['keyId'])\" })"
NOTE_BREAK = 'Anything authenticating with the removed credentials stops working immediately. Each\nremoved credential (keyId, name, expiry) is returned in Before.'

cred('ENTRA-ENTAPP-001', 'Removes all client secrets and certificates from the app registrations you name (apps that no\nlonger need to authenticate as themselves).',
     ALL_SECRETS, ALL_CERTS, '$row.Secrets.Count + $row.Certificates.Count -gt 0', [APPID()], NOTE_BREAK)
cred('ENTRA-ENTAPP-002', 'Removes the client secrets and certificates from inactive apps (no sign-in for 90+ days) that\nyou name.',
     ALL_SECRETS, ALL_CERTS, '$row.Secrets.Count + $row.Certificates.Count -gt 0', [APPID()],
     NOTE_BREAK + '\nTo keep the app but stop it signing in instead, disable its enterprise application.')
cred('ENTRA-ENTAPP-013', 'Removes expired client secrets and certificates from app registrations (all, or the ones you\nname). Expired credentials cannot be used, so nothing stops working.',
     "@($app['passwordCredentials'] | Where-Object { $_ -and $_['endDateTime'] -and [datetime]$_['endDateTime'] -lt $now } | ForEach-Object { \"$($_['keyId'])\" })",
     "@($app['keyCredentials'] | Where-Object { $_ -and $_['endDateTime'] -and [datetime]$_['endDateTime'] -lt $now } | ForEach-Object { \"$($_['keyId'])\" })",
     '$row.Secrets.Count + $row.Certificates.Count -gt 0', [APPID(False)],
     'Only credentials whose end date has passed are removed.', example='', extra_desired='No expired credentials')
cred('ENTRA-ENTAPP-014', 'Removes client secrets from the app registrations you name that also have a certificate, leaving\ncertificate authentication only.',
     ALL_SECRETS, '@()', "$row.Secrets.Count -gt 0 -and @($app['keyCredentials'] | Where-Object { $_ }).Count -gt 0", [APPID()],
     'Confirm the app (and every deployment of it) authenticates with the certificate before running.',
     extra_desired='Certificate only')

emit('ENTRA-ENTAPP-012',
     desc='Moves the app registrations you name from client secrets to a certificate: uploads the\ncertificate\'s public key, then (with -RemoveSecrets) removes the secrets.',
     desired='Certificate credential present; secrets removed with -RemoveSecrets',
     services=['Graph'], scopes=APP_SC,
     params=[APPID(), ('CertificatePath', "[Parameter(Mandatory)]\n[ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]\n[string]", 'Path to the public certificate (.cer, DER or Base-64) the app will authenticate with.'),
             ('RemoveSecrets', "[Parameter()]\n[switch]", 'Remove the client secrets after adding the certificate. Run once without it, switch the app\nover, then run again with it.')],
     example_args=EX_APP + " -CertificatePath '.\\app.cer'",
     notes='The private key never leaves the machine running the app; only the public certificate is\nuploaded.',
     steps=[dict(target='Certificate credential on the listed apps', desired='Certificate from -CertificatePath present',
                 get="$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CertificatePath).Path)\n$thumb = $cert.Thumbprint\n@(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object {\n    @($_['keyCredentials'] | Where-Object { $_ -and \"$($_['customKeyIdentifier'])\" -eq $thumb }).Count -eq 0\n} | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Keys = @($_['keyCredentials'] | Where-Object { $_ }) } })",
                 test=EMPTY,
                 set="$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CertificatePath).Path)\nforeach ($app in $State) {\n    $newKey = @{ type = 'AsymmetricX509Cert'; usage = 'Verify'; key = [Convert]::ToBase64String($cert.RawData); displayName = \"CN=$($cert.GetNameInfo('SimpleName', $false))\" }\n    Set-RemediationGraphObject -Uri \"/v1.0/applications/$($app.Id)\" -Body @{ keyCredentials = @($app.Keys + $newKey) }\n}"),
            dict(target='Client secrets on the listed apps', desired='Removed when -RemoveSecrets is set',
                 get="@(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object { @($_['passwordCredentials'] | Where-Object { $_ }).Count -gt 0 } |\n    ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Secrets = @($_['passwordCredentials'] | ForEach-Object { \"$($_['keyId'])\" }) } })",
                 test='-not $RemoveSecrets.IsPresent -or $null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($app in $State) { Remove-RemediationAppCredential -ObjectId $app.Id -SecretKeyId $app.Secrets }")])

emit('ENTRA-ENTAPP-015',
     desc='For privileged service principals that have a client secret and a permanent directory role,\nremoves the secrets or removes the role assignments.',
     desired='No listed service principal combines a secret with a permanent role',
     services=['Graph'], scopes=['Application.ReadWrite.All', 'RoleManagement.ReadWrite.Directory'],
     params=[SPID, ('Action', "[Parameter(Mandatory)]\n[ValidateSet('RemoveSecrets', 'RemoveRoles')]\n[string]",
                    'RemoveSecrets: delete the service principal\'s (and its app registration\'s) client secrets;\nswitch it to a certificate or managed identity first. RemoveRoles: delete its permanent\ndirectory role assignments; use PIM or narrower Graph permissions instead.')],
     example_args=EX_SP + ' -Action RemoveSecrets',
     steps=[dict(target='Listed service principals with secret + permanent role', desired='"Resolved by $Action"',
                 get="@(foreach ($id in $ServicePrincipalId) {\n    $sp = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/servicePrincipals/$id`?`$select=id,appId,displayName,passwordCredentials\" -OutputType HashTable\n    $roles = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$id'\" -OutputType HashTable)['value']) | Where-Object { $_ }\n    $app = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/applications?`$filter=appId eq '$($sp['appId'])'&`$select=id,passwordCredentials\" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1\n    $spSecrets = @($sp['passwordCredentials'] | Where-Object { $_ } | ForEach-Object { \"$($_['keyId'])\" })\n    $appSecrets = @($app['passwordCredentials'] | Where-Object { $_ } | ForEach-Object { \"$($_['keyId'])\" })\n    if (($spSecrets.Count + $appSecrets.Count) -gt 0 -and @($roles).Count -gt 0) {\n        [PSCustomObject]@{ Id = $id; DisplayName = $sp['displayName']; AppObjectId = $app['id']; SpSecrets = $spSecrets; AppSecrets = $appSecrets; RoleAssignmentIds = @($roles | ForEach-Object { $_['id'] }) }\n    }\n})",
                 test=EMPTY,
                 set="foreach ($finding in $State) {\n    if ($Action -eq 'RemoveSecrets') {\n        Remove-RemediationAppCredential -ObjectId $finding.Id -SecretKeyId $finding.SpSecrets -ServicePrincipal\n        if ($finding.AppObjectId) { Remove-RemediationAppCredential -ObjectId $finding.AppObjectId -SecretKeyId $finding.AppSecrets }\n    }\n    else {\n        foreach ($assignmentId in $finding.RoleAssignmentIds) { Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/roleManagement/directory/roleAssignments/$assignmentId\" | Out-Null }\n    }\n}")])

# ------------------------------------------------------------ permissions
PERM_PARAM = ('Permission', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]",
              "Permission names to remove, as listed in the finding (e.g. 'RoleManagement.ReadWrite.Directory',\n'Mail.ReadWrite'). Use '*' to remove every application permission the app holds.")
RES_PARAM = ("ResourceAppId = '00000003-0000-0000-c000-000000000000'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]",
             'appId of the API the permissions belong to. Defaults to Microsoft Graph.')
APP_PERM_GET = ("$resource = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/servicePrincipals?`$filter=appId eq '$ResourceAppId'&`$select=id,appRoles,oauth2PermissionScopes\" -OutputType HashTable)['value'])[0]\n"
                "$roleNames = @{}\nforeach ($role in @($resource['appRoles'])) { $roleNames[\"$($role['id'])\"] = $role['value'] }\n"
                "@(foreach ($id in $ServicePrincipalId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/servicePrincipals/$id/appRoleAssignments\" -OutputType HashTable)['value']) |\n"
                "        Where-Object { $null -ne $_ -and $_['resourceId'] -eq $resource['id'] -and (@($Permission) -contains '*' -or @($Permission) -contains $roleNames[\"$($_['appRoleId'])\"]) } |\n"
                "        ForEach-Object { [PSCustomObject]@{ ServicePrincipalId = $id; AssignmentId = $_['id']; Permission = $roleNames[\"$($_['appRoleId'])\"]; PrincipalDisplayName = $_['principalDisplayName'] } }\n})")
APP_PERM_SET = "foreach ($assignment in $State) {\n    Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/servicePrincipals/$($assignment.ServicePrincipalId)/appRoleAssignments/$($assignment.AssignmentId)\" | Out-Null\n}"
PERM_CHECKS = {
    'ENTRA-ENTAPP-003': 'Removes Tier-0 (Global Administrator escalation) application permissions from the third-party\napps you name.',
    'ENTRA-ENTAPP-006': 'Removes the application permissions you name from apps holding more than ten, to bring them\nback to least privilege.',
    'ENTRA-ENTAPP-008': 'Removes dangerous application permissions from the managed identities you name. Grant\nnarrower permissions afterwards if the workload still needs access.',
    'ENTRA-ENTAPP-010': 'Removes Tier-0 application permissions from the internal apps you name. Replace them with\nnarrower permissions or a managed identity.',
    'ENTRA-ENTAPP-011': 'Removes Tier-1 data-access application permissions (Mail, Files, Sites, and similar) from the\nthird-party apps you name.',
    'ENTRA-ENTAPP-019': 'Removes Tier-0 application permissions from apps that show no sign-in activity.',
}
for cid, desc in PERM_CHECKS.items():
    emit(cid, desc=desc, desired='Listed permissions removed', services=['Graph'], scopes=['AppRoleAssignment.ReadWrite.All', 'Application.Read.All'],
         params=[SPID, PERM_PARAM, RES_PARAM], example_args=EX_SP + " -Permission 'RoleManagement.ReadWrite.Directory'",
         notes='The app loses the permission immediately. Removed assignments are returned in Before;\nre-grant with New-MgServicePrincipalAppRoleAssignment if needed.',
         steps=[dict(target='Application permission assignments on the listed apps', desired='Removed',
                     get=APP_PERM_GET, test=EMPTY, set=APP_PERM_SET)])

emit('ENTRA-ENTAPP-004',
     desc='Removes the dangerous delegated permissions you name from tenant-wide and per-user grants of\nthe third-party apps you name. Grants left with no permissions are deleted.',
     desired='Listed delegated permissions removed', services=['Graph'], scopes=['DelegatedPermissionGrant.ReadWrite.All'],
     params=[SPID, ('Permission', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", "Delegated scopes to remove (e.g. 'Mail.ReadWrite', 'Directory.AccessAsUser.All'), or '*' for all."),
             ("ResourceAppId = '00000003-0000-0000-c000-000000000000'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'appId of the API. Defaults to Microsoft Graph.')],
     example_args=EX_SP + " -Permission 'Mail.ReadWrite'",
     steps=[dict(target='Delegated grants on the listed apps', desired='Listed scopes removed',
                 get="$resource = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/servicePrincipals?`$filter=appId eq '$ResourceAppId'&`$select=id\" -OutputType HashTable)['value'])[0]\n@(foreach ($id in $ServicePrincipalId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$id' and resourceId eq '$($resource['id'])'\" -OutputType HashTable)['value']) |\n        Where-Object { $_ } | ForEach-Object {\n            $scopes = @(\"$($_['scope'])\" -split ' ' | Where-Object { $_ })\n            $remove = @($scopes | Where-Object { @($Permission) -contains '*' -or @($Permission) -contains $_ })\n            if ($remove.Count -gt 0) { [PSCustomObject]@{ GrantId = $_['id']; ConsentType = $_['consentType']; Scopes = $scopes; Remove = $remove } }\n        }\n})",
                 test=EMPTY,
                 set="foreach ($grant in $State) {\n    $keep = @($grant.Scopes | Where-Object { $grant.Remove -notcontains $_ })\n    if ($keep.Count -eq 0) { Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/oauth2PermissionGrants/$($grant.GrantId)\" | Out-Null }\n    else { Set-RemediationGraphObject -Uri \"/v1.0/oauth2PermissionGrants/$($grant.GrantId)\" -Body @{ scope = ($keep -join ' ') } }\n}")])

for cid, who in (('ENTRA-ENTAPP-005', 'third-party apps'), ('ENTRA-ENTAPP-009', 'managed identities')):
    emit(cid, desc=f'Removes Entra directory role assignments from the {who} you name.',
         desired='No directory roles on the listed service principals', services=['Graph'], scopes=['RoleManagement.ReadWrite.Directory'],
         params=[SPID, ('RoleDefinitionId', "[Parameter()]\n[string[]]", 'Only remove these roles. Defaults to every directory role the service principal holds.')],
         example_args=EX_SP,
         notes='Grant the narrowest Graph application permission the workload needs instead of a role.\nRemoved assignments are returned in Before.',
         steps=[dict(target='Directory role assignments on the listed service principals', desired='Removed',
                     get="@(foreach ($id in $ServicePrincipalId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$id'\" -OutputType HashTable)['value']) |\n        Where-Object { $null -ne $_ -and (@($RoleDefinitionId | Where-Object { $_ }).Count -eq 0 -or @($RoleDefinitionId) -contains $_['roleDefinitionId']) } |\n        ForEach-Object { [PSCustomObject]@{ AssignmentId = $_['id']; PrincipalId = $id; RoleDefinitionId = $_['roleDefinitionId']; DirectoryScopeId = $_['directoryScopeId'] } }\n})",
                     test=EMPTY,
                     set="foreach ($assignment in $State) { Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/roleManagement/directory/roleAssignments/$($assignment.AssignmentId)\" | Out-Null }")])

# ------------------------------------------------------------ owners
for cid, desc in (('ENTRA-ENTAPP-016', 'Removes owners from Tier-0 permission apps you name (owners can add credentials and impersonate\nthe app).'),
                  ('ENTRA-ENTAPP-017', 'Removes owners from the role-holding apps you name (owners can add credentials and use the\napp\'s roles).')):
    emit(cid, desc=desc, desired='No owners on the listed apps (except -KeepOwnerId)', services=['Graph'], scopes=APP_SC,
         params=[APPID(), ('KeepOwnerId', "[Parameter()]\n[string[]]", 'Owners to keep (for example a dedicated, PIM-protected app-admin account).')],
         example_args=EX_APP,
         notes='Both the app registration owners and the enterprise application (service principal) owners\nare removed. Application Administrators can still manage the app.',
         steps=[dict(target='Owners of the listed apps', desired='Removed',
                     get="@(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {\n    $app = $_\n    $sp = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/servicePrincipals?`$filter=appId eq '$($app['appId'])'&`$select=id\" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1\n    $targets = @(@{ Kind = 'applications'; Id = $app['id'] })\n    if ($sp) { $targets += @{ Kind = 'servicePrincipals'; Id = $sp['id'] } }\n    foreach ($t in $targets) {\n        @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/$($t.Kind)/$($t.Id)/owners?`$select=id,userPrincipalName\" -OutputType HashTable)['value']) |\n            Where-Object { $null -ne $_ -and @($KeepOwnerId) -notcontains $_['id'] } |\n            ForEach-Object { [PSCustomObject]@{ Kind = $t.Kind; ObjectId = $t.Id; App = $app['displayName']; OwnerId = $_['id']; Owner = $_['userPrincipalName'] } }\n    }\n})",
                     test=EMPTY,
                     set="foreach ($owner in $State) { Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/$($owner.Kind)/$($owner.ObjectId)/owners/$($owner.OwnerId)/`$ref\" | Out-Null }")])

emit('ENTRA-ENTAPP-018',
     desc='Assigns an owner to app registrations that have credentials but no owners, so someone is\naccountable for rotating credentials and reviewing permissions.',
     desired='Every credentialed app has an owner', services=['Graph'], scopes=APP_SC,
     params=[('OwnerId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string]", 'Object ID of the user to make owner.'),
             APPID(False)],
     example_args="-OwnerId '00000000-0000-0000-0000-000000000001'",
     notes='Do not use this for Tier-0 or role-holding apps (see ENTRA-ENTAPP-016/017): an owner of\nthose can escalate privilege.',
     steps=[dict(target='Credentialed apps with no owners', desired='"Owner $OwnerId assigned"',
                 get="@(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object {\n    (@($_['passwordCredentials'] | Where-Object { $_ }).Count + @($_['keyCredentials'] | Where-Object { $_ }).Count) -gt 0\n} | Where-Object {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/applications/$($_['id'])/owners?`$select=id\" -OutputType HashTable)['value'] | Where-Object { $_ }).Count -eq 0\n} | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName'] } })",
                 test=EMPTY,
                 set="foreach ($app in $State) {\n    Set-RemediationGraphObject -Uri \"/v1.0/applications/$($app.Id)/owners/`$ref\" -Method POST -Body @{ '@odata.id' = \"https://graph.microsoft.com/v1.0/directoryObjects/$OwnerId\" }\n}")])

emit('ENTRA-ENTAPP-021',
     desc='Changes the app registrations you name from multi-tenant to single-tenant (AzureADMyOrg).',
     desired='signInAudience = AzureADMyOrg on the listed apps', services=['Graph'], scopes=APP_SC,
     params=[APPID()], example_args=EX_APP,
     notes='Users from other tenants can no longer sign in to these apps. Apps that also allow personal\nMicrosoft accounts may need their API permissions or token version adjusted first.',
     steps=[dict(target='Multi-tenant app registrations', desired='Single-tenant',
                 get="@(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object { $_['signInAudience'] -ne 'AzureADMyOrg' } |\n    ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; SignInAudience = $_['signInAudience'] } })",
                 test=EMPTY,
                 set="foreach ($app in $State) { Set-RemediationGraphObject -Uri \"/v1.0/applications/$($app.Id)\" -Body @{ signInAudience = 'AzureADMyOrg' } }")])

graph_props('ENTRA-ENTAPP-007', uri='/v1.0/policies/defaultAppManagementPolicy', body={'isEnabled': True},
            scopes=['Policy.ReadWrite.ApplicationConfiguration'], target='Tenant default app management policy',
            desc='Turns on the tenant default app management policy, which enforces credential restrictions on\napp registrations and service principals.',
            notes='Add restrictions (for example a maximum secret lifetime, or blocking new secrets) in the\nsame policy; some restriction types need Workload ID Premium. Per-app instance property lock\nis set on each multi-tenant app under Authentication > App instance property lock.')
print('ok')
