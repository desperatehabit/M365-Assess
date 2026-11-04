from gen import emit

# checkId -> (setting name used by the collector, desired enabled, plain-language effect)
PBI = {
    'POWERBI-GUEST-001': ('AllowGuestLookup', False, 'Guest users can no longer browse the tenant directory from Power BI.'),
    'PBI-GUEST-001': ('AllowGuestLookup', False, 'Guest users can no longer browse the tenant directory from Power BI.'),
    'POWERBI-GUEST-002': ('ElevatedGuestsTenant', False, 'Guest users can no longer invite other external users.'),
    'PBI-INVITE-001': ('ElevatedGuestsTenant', False, 'Guest users can no longer invite other external users.'),
    'POWERBI-GUEST-003': ('AllowGuestUserToAccessSharedContent', False, 'Guest users lose access to shared Power BI content.'),
    'PBI-CONTENT-001': ('AllowGuestUserToAccessSharedContent', False, 'Guest users lose access to shared Power BI content.'),
    'PBI-TENANT-003': ('AllowGuestUserToAccessSharedContent', False, 'Guest users lose access to shared Power BI content.'),
    'POWERBI-SHARING-001': ('WebDashboardsPublishToWebDisabled', True, 'Publish to web is turned off for the tenant.'),
    'PBI-PUBLISH-001': ('WebDashboardsPublishToWebDisabled', True, 'Publish to web is turned off for the tenant.'),
    'PBI-TENANT-002': ('WebDashboardsPublishToWebDisabled', True, 'Publish to web is turned off for the tenant.'),
    'POWERBI-SHARING-002': ('RScriptVisuals', False, 'R and Python visuals can no longer be created or shared.'),
    'PBI-SCRIPT-001': ('RScriptVisuals', False, 'R and Python visuals can no longer be created or shared.'),
    'POWERBI-SHARING-003': ('ShareLinkToEntireOrg', False, 'Users can no longer create "people in your organization" links.'),
    'PBI-LINK-001': ('ShareLinkToEntireOrg', False, 'Users can no longer create "people in your organization" links.'),
    'POWERBI-SHARING-004': ('AllowExternalDataSharingReceiverWorksWithShare', False, 'External data sharing receivers are blocked.'),
    'PBI-SHARING-001': ('AllowExternalDataSharingReceiverWorksWithShare', False, 'External data sharing receivers are blocked.'),
    'PBI-TENANT-001': ('ExternalSharingV2', False, 'Users can no longer invite guest users through item sharing.'),
    'POWERBI-INFOPROT-001': ('UseSensitivityLabels', True, 'Users can apply sensitivity labels to Power BI content.'),
    'PBI-LABELS-001': ('UseSensitivityLabels', True, 'Users can apply sensitivity labels to Power BI content.'),
    'POWERBI-AUTH-001': ('BlockResourceKeyAuthentication', True, 'Resource-key authentication for streaming datasets is blocked.'),
    'PBI-AUTH-001': ('BlockResourceKeyAuthentication', True, 'Resource-key authentication for streaming datasets is blocked.'),
    'POWERBI-AUTH-002': ('ServicePrincipalAccess', False, 'Service principals can no longer call Fabric public APIs unless re-enabled for a group.'),
    'PBI-API-001': ('ServicePrincipalAccess', False, 'Service principals can no longer call Fabric public APIs unless re-enabled for a group.'),
    'POWERBI-AUTH-003': ('CreateServicePrincipalProfile', False, 'Service principals can no longer create and use profiles.'),
    'PBI-PROFILE-001': ('CreateServicePrincipalProfile', False, 'Service principals can no longer create and use profiles.'),
    'POWERBI-SERVICEPRINCIPAL-001': ('ServicePrincipalAccessGlobalAPIs', False, 'Service principals can no longer create workspaces, connections, or deployment pipelines.'),
}

# Settings where "restricted to a group" is an acceptable compliant state.
GROUPABLE = {'ServicePrincipalAccess', 'CreateServicePrincipalProfile', 'ServicePrincipalAccessGlobalAPIs',
             'ElevatedGuestsTenant', 'AllowGuestUserToAccessSharedContent', 'ExternalSharingV2',
             'ShareLinkToEntireOrg', 'AllowExternalDataSharingReceiverWorksWithShare', 'RScriptVisuals'}

for cid, (name, enabled, effect) in PBI.items():
    want = '$true' if enabled else '$false'
    params = [(f"SettingName = '{name}'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]",
               f"Fabric tenant setting name. Defaults to '{name}', the name the Power BI collector reads.\nOverride if your tenant lists the setting under a different name.")]
    notes = ''
    test = f'$State.enabled -eq {want}'
    setb = f'Set-PowerBITenantSettingState -SettingName $SettingName -Enabled {want}'
    desired = f'{name} enabled = {enabled}'
    if name in GROUPABLE and not enabled:
        params.append(('AllowedSecurityGroupId', "[Parameter()]\n[string[]]",
                       'Optional Entra security group object IDs. When supplied, the setting stays enabled\nbut only for these groups (the CIS-acceptable "specific security groups" option)\ninstead of being turned off for everyone.'))
        test = ('if ($AllowedSecurityGroupId.Count -gt 0) {\n'
                '    $current = @($State.enabledSecurityGroups | ForEach-Object { $_.graphId })\n'
                '    $State.enabled -eq $true -and $current.Count -gt 0 -and @($current | Where-Object { $AllowedSecurityGroupId -notcontains $_ }).Count -eq 0\n'
                '}\nelse {\n    $State.enabled -eq $false\n}')
        setb = ('if ($AllowedSecurityGroupId.Count -gt 0) {\n'
                '    Set-PowerBITenantSettingState -SettingName $SettingName -Enabled $true -EnabledSecurityGroupIds $AllowedSecurityGroupId\n'
                '}\nelse {\n    Set-PowerBITenantSettingState -SettingName $SettingName -Enabled $false\n}')
        desired = f'{name} disabled, or enabled only for -AllowedSecurityGroupId'
    if cid in ('POWERBI-SHARING-001', 'PBI-PUBLISH-001', 'PBI-TENANT-002'):
        notes = 'Existing public embed codes are not revoked by this setting. Review and delete them\nunder Power BI Admin portal > Embed codes.'
    if cid in ('POWERBI-INFOPROT-001', 'PBI-LABELS-001'):
        notes = 'Labels must also be published to Power BI users from the Microsoft Purview portal.'
    emit(cid,
         desc=f"Updates the Fabric tenant setting '{name}' through the Fabric admin API.\n{effect}",
         desired=desired, services=['PowerBI'], params=params, notes=notes,
         steps=[dict(target=f'"Fabric tenant setting $SettingName"', desired=desired,
                     get='Get-PowerBITenantSettingState -SettingName $SettingName',
                     test=test, set=setb)])
print(len(PBI))
