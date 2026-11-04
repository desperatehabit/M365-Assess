from gen import emit
import spec_entapp as ea  # reuses the app-permission helpers (re-emits EntApp scripts unchanged)

EMPTY = '$null -eq $State -or @($State).Count -eq 0'
CORE = {
    '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
    'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
    '7be44c8a-adaf-4e2a-84d6-ab2649e08a13': 'Privileged Authentication Administrator',
    '194ae4cb-b126-40b2-bd5b-6091b380977d': 'Security Administrator',
    'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9': 'Conditional Access Administrator',
    '3a2c62db-5318-420d-8d74-23affee5d9d5': 'Intune Administrator',
    '29232cdf-9323-42fd-ade2-1d097af3e4de': 'Exchange Administrator',
    'fe930be7-5e62-47db-91af-98c3a49a38b1': 'User Administrator',
    '158c047a-c907-4556-b7ef-446551a6b5f7': 'Cloud Application Administrator',
    '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3': 'Application Administrator',
}
items = list(CORE.items())
ROLES = ('RoleDefinitionId = @(\n    ' + '\n    '.join(f"'{k}'{',' if i < len(items) - 1 else ''} # {v}" for i, (k, v) in enumerate(items)) + '\n)',
         "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Privileged role template IDs to evaluate. Defaults to the core admin roles listed in the script.')
BG = ('BreakGlassAccountId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of emergency-access accounts, which are always left alone.')
ADMIN_IDS = ("$adminIds = @(foreach ($roleId in $RoleDefinitionId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'\" -OutputType HashTable)['value']) |\n"
             "        Where-Object { $_ } | ForEach-Object { $_['principalId'] }\n}) | Sort-Object -Unique")

# ------------------------------------------------------------ DNS
emit('DNS-DKIM-001',
     desc='Turns on DKIM signing for every authoritative accepted domain. Domains without a DKIM\nconfiguration get one created (disabled) and the two CNAME records to publish are written as\nwarnings; re-run after DNS has propagated to enable signing.',
     desired='DKIM signing enabled for every authoritative domain', services=['ExchangeOnline'],
     params=[('DomainName', "[Parameter()]\n[string[]]", 'Domains to enable. Defaults to every authoritative accepted domain.')],
     notes='Same remediation as EXO-DKIM-001. Enabling fails until selector1/selector2 CNAMEs resolve in\npublic DNS; those domains report VerifyFailed with the records to publish.',
     prelude="$targets = if (@($DomainName | Where-Object { $_ }).Count -gt 0) { @($DomainName) } else {\n    @(Get-AcceptedDomain | Where-Object { $_.DomainType -eq 'Authoritative' -and \"$($_.DomainName)\" -notlike '*.onmicrosoft.com' } | ForEach-Object { \"$($_.DomainName)\" })\n}",
     steps=[dict(target='"DKIM signing for: $($targets -join \', \')"', desired='Enabled',
                 get="@(foreach ($domain in $targets) {\n    $config = Get-DkimSigningConfig -Identity $domain -ErrorAction SilentlyContinue\n    [PSCustomObject]@{ Domain = $domain; Exists = $null -ne $config; Enabled = [bool]$config.Enabled; Selector1CNAME = $config.Selector1CNAME; Selector2CNAME = $config.Selector2CNAME }\n})",
                 test='@($State | Where-Object { $null -ne $_ -and -not $_.Enabled }).Count -eq 0',
                 set="foreach ($domain in @($State | Where-Object { $null -ne $_ -and -not $_.Enabled })) {\n    if (-not $domain.Exists) {\n        $created = New-DkimSigningConfig -DomainName $domain.Domain -Enabled $false\n        Write-Warning \"Publish for $($domain.Domain): selector1._domainkey CNAME $($created.Selector1CNAME); selector2._domainkey CNAME $($created.Selector2CNAME). Re-run after DNS propagates.\"\n        continue\n    }\n    try { Set-DkimSigningConfig -Identity $domain.Domain -Enabled $true }\n    catch { Write-Warning \"Could not enable DKIM for $($domain.Domain) (publish selector1._domainkey CNAME $($domain.Selector1CNAME) and selector2._domainkey CNAME $($domain.Selector2CNAME)): $($_.Exception.Message)\" }\n}")])

# ------------------------------------------------------------ Stryker readiness
emit('CA-EXCLUSION-001',
     desc='Removes privileged administrators from Conditional Access policy user exclusions, keeping only\nyour break-glass accounts excluded.',
     desired='No enabled CA policy excludes a privileged admin (other than break-glass)', services=['Graph'],
     scopes=['Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'RoleManagement.Read.Directory'],
     params=[BG, ROLES], example_args="-BreakGlassAccountId '00000000-0000-0000-0000-000000000001'",
     notes='Admins that were excluded become subject to those policies immediately (MFA, device, location).\nUse PIM just-in-time activation instead of standing exclusions.',
     steps=[dict(target='CA policies excluding privileged admins', desired='Only break-glass excluded',
                 get=ADMIN_IDS + "\n@(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $null -ne $_ -and $_['state'] -eq 'enabled' } | ForEach-Object {\n    $excluded = @($_['conditions']['users']['excludeUsers'])\n    $admins = @($excluded | Where-Object { $adminIds -contains $_ -and @($BreakGlassAccountId) -notcontains $_ })\n    if ($admins.Count -gt 0) { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Users = $_['conditions']['users']; ExcludeUsers = $excluded; ExcludedAdmins = $admins } }\n})",
                 test=EMPTY,
                 set="foreach ($p in $State) {\n    $keep = @($p.ExcludeUsers | Where-Object { $p.ExcludedAdmins -notcontains $_ })\n    $users = @{}\n    foreach ($k in $p.Users.Keys) { $users[$k] = $p.Users[$k] }\n    $users['excludeUsers'] = $keep\n    $patch = @{ conditions = @{ users = $users } }\n    Invoke-MgGraphRequest -Method PATCH -Uri \"/v1.0/identity/conditionalAccess/policies/$($p.Id)\" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 10) | Out-Null\n}")])

INTUNE_WRITE = ['DeviceManagementConfiguration.ReadWrite.All', 'DeviceManagementManagedDevices.ReadWrite.All',
                'DeviceManagementManagedDevices.PrivilegedOperations.All', 'DeviceManagementApps.ReadWrite.All',
                'DeviceManagementRBAC.ReadWrite.All', 'DeviceManagementServiceConfig.ReadWrite.All',
                'DeviceManagementScripts.ReadWrite.All']
emit('ENTRA-APPS-002',
     desc='Removes Intune write permissions (device configuration, managed devices, wipe, apps, RBAC,\nscripts) from the apps you name. A compromised app with these can wipe or reconfigure every device.',
     desired='Listed apps hold no Intune write permissions', services=['Graph'], scopes=['AppRoleAssignment.ReadWrite.All', 'Application.Read.All'],
     params=[ea.SPID, ("Permission = @(\n    " + ",\n    ".join(f"'{p}'" for p in INTUNE_WRITE) + "\n)", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Permissions to remove. Defaults to the Intune write permissions listed in the script.'), ea.RES_PARAM],
     example_args=ea.EX_SP,
     notes='Approved automation that needs one of these should keep it with an owner, monitoring, and a\ncertificate credential. Removed assignments are returned in Before.',
     steps=[dict(target='Intune write permissions on the listed apps', desired='Removed', get=ea.APP_PERM_GET, test=EMPTY, set=ea.APP_PERM_SET)])

emit('ENTRA-ROLEGROUP-001',
     desc='For each unprotected group you name that holds a privileged role, creates a role-assignable\n(protected) copy with the same members, gives it the same role assignments, and optionally\nremoves the original group\'s assignments.',
     desired='Role assignments held by role-assignable groups only', services=['Graph'],
     scopes=['Group.ReadWrite.All', 'RoleManagement.ReadWrite.Directory'],
     params=[('GroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Object IDs of the unprotected groups that hold directory roles.'),
             ('RemoveOriginalAssignment', "[Parameter()]\n[switch]", 'Also delete the original group\'s role assignments once the copy holds them.'),
             ("Suffix = ' (protected)'", "[Parameter()]\n[string]", 'Text appended to the new group names.')],
     example_args="-GroupId '00000000-0000-0000-0000-000000000001'",
     notes='Run once without -RemoveOriginalAssignment, confirm members can use the role through the new\ngroup, then run again with it. isAssignableToRole cannot be turned on for an existing group.',
     steps=[dict(target='Role assignments held by unprotected groups', desired='Moved to protected copies',
                 get="@(foreach ($id in $GroupId) {\n    $g = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups/$id`?`$select=id,displayName,mailNickname,isAssignableToRole\" -OutputType HashTable\n    if ($g['isAssignableToRole'] -eq $true) { continue }\n    $assignments = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$id'\" -OutputType HashTable)['value']) | Where-Object { $_ }\n    $name = \"$($g['displayName'])$Suffix\"\n    $copy = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups?`$filter=displayName eq '$($name.Replace(\"'\", \"''\"))'&`$select=id\" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1\n    $copyHasRoles = $false\n    if ($copy) { $copyHasRoles = @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$($copy['id'])'\" -OutputType HashTable)['value'] | Where-Object { $_ }).Count -ge @($assignments).Count }\n    if (-not $copyHasRoles -or ($RemoveOriginalAssignment.IsPresent -and @($assignments).Count -gt 0)) {\n        [PSCustomObject]@{ SourceId = $id; SourceName = $g['displayName']; Nickname = $g['mailNickname']; NewName = $name; CopyId = $copy['id']; CopyHasRoles = $copyHasRoles; Assignments = @($assignments) }\n    }\n})",
                 test=EMPTY,
                 set="foreach ($item in $State) {\n    $copyId = $item.CopyId\n    if (-not $copyId) {\n        $new = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/groups' -OutputType HashTable -ContentType 'application/json' -Body (@{ displayName = $item.NewName; mailEnabled = $false; mailNickname = \"$($item.Nickname)-protected\"; securityEnabled = $true; isAssignableToRole = $true } | ConvertTo-Json)\n        $copyId = $new['id']\n        foreach ($member in @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/groups/$($item.SourceId)/members?`$select=id&`$top=999\" -OutputType HashTable)['value'] | Where-Object { $_ })) {\n            Set-RemediationGraphObject -Uri \"/v1.0/groups/$copyId/members/`$ref\" -Method POST -Body @{ '@odata.id' = \"https://graph.microsoft.com/v1.0/directoryObjects/$($member['id'])\" }\n        }\n    }\n    if (-not $item.CopyHasRoles) {\n        foreach ($a in $item.Assignments) {\n            Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleAssignments' -Method POST -Body @{ principalId = $copyId; roleDefinitionId = $a['roleDefinitionId']; directoryScopeId = $a['directoryScopeId'] }\n        }\n    }\n    if ($RemoveOriginalAssignment.IsPresent) {\n        foreach ($a in $item.Assignments) { Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/roleManagement/directory/roleAssignments/$($a['id'])\" | Out-Null }\n    }\n}")])

emit('ENTRA-STALEADMIN-001',
     desc='Disables, or removes the roles of, privileged admin accounts with no sign-in for 90 days or\nmore. Break-glass accounts are never touched.',
     desired='No privileged admin inactive past -InactiveDays', services=['Graph'],
     scopes=['User.ReadWrite.All', 'AuditLog.Read.All', 'RoleManagement.ReadWrite.Directory'],
     params=[BG, ('Action', "[Parameter(Mandatory)]\n[ValidateSet('Disable', 'RemoveRoles')]\n[string]", 'Disable the account, or remove its directory role assignments.'),
             ('InactiveDays = 90', "[Parameter()]\n[ValidateRange(30, 3650)]\n[int]", 'Days without sign-in that count as stale.'), ROLES],
     example_args="-BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -Action Disable",
     notes='Only direct role assignments are evaluated. Remove stale PIM eligible assignments in PIM.',
     steps=[dict(target='Stale privileged admin accounts', desired='"Handled by $Action"',
                 get="$cutoff = (Get-Date).ToUniversalTime().AddDays(-$InactiveDays)\n@($(foreach ($roleId in $RoleDefinitionId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'\" -OutputType HashTable)['value']) | Where-Object { $_ }\n}) | Group-Object -Property { $_['principalId'] } | ForEach-Object {\n    $id = $_.Name\n    if (@($BreakGlassAccountId) -contains $id) { return }\n    $user = Invoke-MgGraphRequest -Method GET -Uri \"/beta/users/$id`?`$select=id,userPrincipalName,accountEnabled,signInActivity\" -OutputType HashTable -ErrorAction SilentlyContinue\n    if ($null -eq $user -or $null -eq $user['userPrincipalName']) { return }\n    $last = $user['signInActivity']['lastSignInDateTime']\n    $stale = $null -eq $last -or [datetime]$last -lt $cutoff\n    $pending = if ($Action -eq 'Disable') { $user['accountEnabled'] -ne $false } else { $true }\n    if ($stale -and $pending) { [PSCustomObject]@{ Id = $id; UserPrincipalName = $user['userPrincipalName']; LastSignIn = $last; AssignmentIds = @($_.Group | ForEach-Object { $_['id'] }) } }\n})",
                 test=EMPTY,
                 set="foreach ($admin in $State) {\n    if ($Action -eq 'Disable') { Set-RemediationGraphObject -Uri \"/v1.0/users/$($admin.Id)\" -Body @{ accountEnabled = $false } }\n    else { foreach ($a in $admin.AssignmentIds) { Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/roleManagement/directory/roleAssignments/$a\" | Out-Null } }\n}")])

emit('ENTRA-SYNCADMIN-001',
     desc='Removes core admin role assignments from accounts synced from on-premises AD, after you have\nset up cloud-only replacement admins.',
     desired='No synced account holds a core admin role', services=['Graph'], scopes=['RoleManagement.ReadWrite.Directory', 'User.Read.All'],
     params=[ROLES, ('ExcludeUserId', "[Parameter()]\n[string[]]", 'Synced accounts to leave as they are.'),
             ('ConfirmReplacementAccounts', "[Parameter(Mandatory)]\n[switch]", 'Confirms cloud-only replacement admins already hold these roles.')],
     example_args='-ConfirmReplacementAccounts',
     notes='Same approach as ENTRA-HYBRID-002, scoped to the core admin roles.',
     steps=[dict(target='Core admin roles held by synced accounts', desired='None',
                 get="@(foreach ($roleId in $RoleDefinitionId) {\n    @((Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'&`$expand=principal\" -OutputType HashTable)['value']) |\n        Where-Object { $null -ne $_ -and $_['principal']['onPremisesSyncEnabled'] -eq $true -and @($ExcludeUserId) -notcontains $_['principalId'] } |\n        ForEach-Object { [PSCustomObject]@{ AssignmentId = $_['id']; RoleDefinitionId = $roleId; UserPrincipalName = $_['principal']['userPrincipalName'] } }\n})",
                 test=EMPTY,
                 set="foreach ($a in $State) { Invoke-MgGraphRequest -Method DELETE -Uri \"/v1.0/roleManagement/directory/roleAssignments/$($a.AssignmentId)\" | Out-Null }")])

MAA_TYPES = ['deviceWipe', 'deviceRetire', 'deviceDelete', 'script', 'app']
emit('INTUNE-MAA-001',
     desc='Turns on Intune Multi Admin Approval for destructive operations (wipe, retire, delete, scripts,\napps), with approvals from the group you name.',
     desired='An approval policy exists for each -PolicyType', services=['Graph'], scopes=['DeviceManagementRBAC.ReadWrite.All'],
     params=[('ApproverGroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Groups whose members approve requests (cannot approve their own).'),
             ("PolicyType = @(" + ', '.join(f"'{t}'" for t in MAA_TYPES) + ")", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Operation types to protect.')],
     example_args="-ApproverGroupId '00000000-0000-0000-0000-000000000001'",
     notes='Uses the Graph beta operationApprovalPolicies endpoint. Once on, every protected operation\nneeds a second admin to approve it in Tenant administration > Multi Admin Approval.',
     steps=[dict(target='Intune Multi Admin Approval policies', desired='One per operation type',
                 get="$existing = @(@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/operationApprovalPolicies' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object { \"$($_['policyType'])\" })\n@($PolicyType | Where-Object { $existing -notcontains $_ })",
                 test=EMPTY,
                 set="foreach ($type in $State) {\n    Set-RemediationGraphObject -Uri '/beta/deviceManagement/operationApprovalPolicies' -Method POST -Body @{\n        displayName      = \"M365-Assess - Approval for $type\"\n        description      = 'Created by M365-Assess remediation INTUNE-MAA-001'\n        policyType       = $type\n        policyPlatform   = 'notApplicable'\n        approverGroupIds = @($ApproverGroupId)\n    }\n}")])

emit('INTUNE-RBAC-001',
     desc='Limits the Intune role assignments you name to the groups of users/devices they should manage\n(scope groups), and optionally to scope tags.',
     desired='Listed role assignments are scoped', services=['Graph'], scopes=['DeviceManagementRBAC.ReadWrite.All'],
     params=[('RoleAssignmentId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'IDs of the Intune role assignments to scope.'),
             ('ScopeGroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Groups of users/devices the assigned admins may manage.'),
             ('ScopeTagId', "[Parameter()]\n[string[]]", 'Scope tag IDs to add, limiting which objects the admins can see.')],
     example_args="-RoleAssignmentId '<id>' -ScopeGroupId '00000000-0000-0000-0000-000000000001'",
     steps=[dict(target='Listed Intune role assignments', desired='Scoped to -ScopeGroupId',
                 get="@(foreach ($id in $RoleAssignmentId) {\n    $a = Invoke-MgGraphRequest -Method GET -Uri \"/beta/deviceManagement/roleAssignments/$id\" -OutputType HashTable\n    $scopes = @($a['resourceScopes'])\n    $broad = $scopes.Count -eq 0 -or ($scopes.Count -eq 1 -and \"$($scopes[0])\" -eq '0') -or @($ScopeGroupId | Where-Object { $scopes -notcontains $_ }).Count -gt 0\n    $tagsMissing = @($ScopeTagId | Where-Object { $_ -and @($a['roleScopeTagIds']) -notcontains $_ }).Count -gt 0\n    if ($broad -or $tagsMissing) { [PSCustomObject]@{ Id = $id; DisplayName = $a['displayName']; ResourceScopes = $scopes; RoleScopeTagIds = @($a['roleScopeTagIds']) } }\n})",
                 test=EMPTY,
                 set="foreach ($a in $State) {\n    $body = @{ '@odata.type' = '#microsoft.graph.deviceAndAppManagementRoleAssignment'; resourceScopes = @($ScopeGroupId); scopeType = 'resourceScope' }\n    if (@($ScopeTagId | Where-Object { $_ }).Count -gt 0) { $body['roleScopeTagIds'] = @(@($a.RoleScopeTagIds) + $ScopeTagId | Where-Object { $_ } | Sort-Object -Unique) }\n    Set-RemediationGraphObject -Uri \"/beta/deviceManagement/roleAssignments/$($a.Id)\" -Body $body\n}")])
print('ok')
