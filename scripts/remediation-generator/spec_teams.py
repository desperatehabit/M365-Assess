from gen import emit, graph_props, cmdlet_props, cmdlet_step

MP = dict(service='Teams', get='Get-CsTeamsMeetingPolicy -Identity Global',
          setcmd='Set-CsTeamsMeetingPolicy -Identity Global', target='Teams meeting policy Global')
FED = dict(service='Teams', get='Get-CsTenantFederationConfiguration -Identity Global',
           setcmd='Set-CsTenantFederationConfiguration -Identity Global', target='Teams tenant federation configuration')
CLIENT = dict(service='Teams', get='Get-CsTeamsClientConfiguration -Identity Global',
              setcmd='Set-CsTeamsClientConfiguration -Identity Global', target='Teams client configuration Global')
NOTE_GLOBAL = 'Changes the Global (org-wide default) policy only. Users assigned a custom policy keep\nthat policy; review custom policies with Get-CsTeamsMeetingPolicy.'

meeting = {
    'TEAMS-MEETING-001': ({'AllowAnonymousUsersToJoinMeeting': False}, None, 'Anonymous users can no longer join meetings.'),
    'TEAMS-MEETING-002': ({'AllowAnonymousUsersToStartMeeting': False}, None, 'Anonymous users and dial-in callers can no longer start meetings.'),
    'TEAMS-MEETING-003': ({'AutoAdmittedUsers': 'EveryoneInCompanyExcludingGuests'},
                          "@('EveryoneInCompanyExcludingGuests', 'EveryoneInSameAndFederatedCompany', 'OrganizerOnly', 'InvitedUsers') -contains $State.AutoAdmittedUsers",
                          'Only people in the organization (excluding guests) bypass the lobby. Stricter existing values are kept.'),
    'TEAMS-MEETING-004': ({'AllowPSTNUsersToBypassLobby': False}, None, 'Dial-in callers wait in the lobby.'),
    'TEAMS-MEETING-005': ({'AllowExternalParticipantGiveRequestControl': False}, None, 'External participants can no longer give or request control.'),
    'TEAMS-MEETING-006': ({'MeetingChatEnabledType': 'EnabledExceptAnonymous'},
                          "-not [string]::IsNullOrEmpty($State.MeetingChatEnabledType) -and $State.MeetingChatEnabledType -ne 'Enabled'",
                          'Meeting chat stays on for everyone except anonymous users. An existing Disabled value is kept.'),
    'TEAMS-MEETING-007': ({'DesignatedPresenterRoleMode': 'OrganizerOnlyUserOverride'}, None, 'Only organizers and co-organizers present by default.'),
    'TEAMS-MEETING-008': ({'AllowExternalNonTrustedMeetingChat': False}, None, 'Chat with untrusted external meeting participants is off.'),
    'TEAMS-MEETING-009': ({'AllowCloudRecording': False}, None, 'Cloud recording is off by default.'),
}
for cid, (exp, test, eff) in meeting.items():
    cmdlet_props(cid, **MP, expected=exp, test=test, notes=NOTE_GLOBAL,
                 desc=f'Updates the Global Teams meeting policy.\n{eff}')

for cid, (exp, eff) in {
    'TEAMS-EXTACCESS-001': ({'AllowTeamsConsumer': False}, 'Users can no longer communicate with unmanaged (personal) Teams accounts.'),
    'TEAMS-EXTACCESS-002': ({'AllowTeamsConsumerInbound': False}, 'Unmanaged Teams accounts can no longer start conversations with your users.'),
    'TEAMS-EXTACCESS-004': ({'AllowPublicUsers': False}, 'Users can no longer communicate with Skype (consumer) users.'),
}.items():
    cmdlet_props(cid, **FED, expected=exp, desc=f'Updates the tenant federation configuration.\n{eff}')

cmdlet_props('TEAMS-CLIENT-002', **CLIENT, expected={'AllowEmailIntoChannel': False},
             desc='Updates the Global Teams client configuration.\nUsers can no longer email a channel address.',
             notes='Existing channel email addresses stop accepting mail.')

graph_props('TEAMS-APPS-001', uri='/v1.0/teamwork/teamsAppSettings', body={'isChatResourceSpecificConsentEnabled': False},
            scopes=['TeamworkAppSettings.ReadWrite.All'], target='Teams app settings',
            desc='Turns off chat resource-specific consent (RSC), so users can no longer grant apps\naccess to chat data.',
            notes='Apps that already rely on chat RSC permissions stop receiving them.')

# --- Needs decision -------------------------------------------------------
STORES = ['DropBox', 'Box', 'GoogleDrive', 'ShareFile', 'Egnyte']
emit('TEAMS-CLIENT-001',
     desc='Turns off third-party cloud storage providers in the Global Teams client configuration,\nexcept any the organization has approved.',
     desired='All third-party storage providers disabled except -ApprovedProvider',
     services=['Teams'],
     params=[('ApprovedProvider', "[Parameter()]\n[ValidateSet('DropBox', 'Box', 'GoogleDrive', 'ShareFile', 'Egnyte')]\n[string[]]",
              'Providers to leave as they are (not disabled). The assessment check only passes when none are enabled,\nso anything listed here is recorded as an accepted exception.')],
     prelude="$approved = @($ApprovedProvider | Where-Object { $_ })\n$settings = @{}\nforeach ($provider in @('" + "', '".join(STORES) + "')) {\n    if ($approved -notcontains $provider) { $settings[\"Allow$provider\"] = $false }\n}\nif ($approved.Count -gt 0) {\n    Write-Warning \"Leaving enabled: $($approved -join ', '). TEAMS-CLIENT-001 will still report Fail for these.\"\n}",
     steps=[dict(target='Teams client configuration Global', desired='Third-party storage limited to approved providers',
                 get=CLIENT['get'], test='Test-RemediationProperty -State $State -Expected $settings',
                 set=CLIENT['setcmd'] + ' @settings')])

emit('TEAMS-EXTACCESS-003',
     desc='Restricts Teams federation (external access) to an allow-list of domains, or turns it off.',
     desired='Federation limited to -AllowedDomain, or disabled with -DisableFederation',
     services=['Teams'],
     params=[('AllowedDomain', "[Parameter(Mandatory, ParameterSetName = 'AllowList')]\n[ValidateNotNullOrEmpty()]\n[string[]]",
              'External domains users may communicate with. Replaces the current allow-list.'),
             ('DisableFederation', "[Parameter(Mandatory, ParameterSetName = 'Disable')]\n[switch]",
              'Turn off communication with all external Teams organizations.')],
     example_args="-AllowedDomain 'partner.example'",
     notes='The allow-list replaces any existing list; include every partner domain you need.\nBlocked-domain lists are cleared when switching to an allow-list.',
     steps=[dict(target='Teams tenant federation configuration', desired='Federation restricted',
                 get=FED['get'],
                 test="if ($DisableFederation.IsPresent) {\n    $State.AllowFederatedUsers -eq $false\n}\nelse {\n    $current = @($State.AllowedDomains.AllowedDomain | ForEach-Object { if ($_.Domain) { $_.Domain } else { \"$_\" } } | Sort-Object)\n    $State.AllowFederatedUsers -eq $true -and ($current -join ',') -eq (@($AllowedDomain | Sort-Object) -join ',')\n}",
                 set="if ($DisableFederation.IsPresent) {\n    Set-CsTenantFederationConfiguration -Identity Global -AllowFederatedUsers $false\n}\nelse {\n    Set-CsTenantFederationConfiguration -Identity Global -AllowFederatedUsers $true -AllowedDomainsAsAList @($AllowedDomain)\n}")])

emit('TEAMS-GUEST-001',
     desc='Either turns off guest access in Teams, or keeps it on and restricts guest calling,\nmeeting, and messaging capabilities to a minimal set.',
     desired='Guest access disabled (-Mode Disable) or restricted (-Mode Restrict)',
     services=['Teams'],
     params=[('Mode', "[Parameter(Mandatory)]\n[ValidateSet('Disable', 'Restrict')]\n[string]",
              "Disable: turn off guest access entirely (existing guests lose Teams access).\nRestrict: keep guest access, but block private calling, video, screen sharing,\nMeet Now, and message edit/delete for guests.")],
     example_args="-Mode Restrict",
     steps=[
         cmdlet_step(get='Get-CsTeamsClientConfiguration -Identity Global', setcmd='Set-CsTeamsClientConfiguration -Identity Global',
                     expected={'AllowGuestUser': '$allowGuest'}, target='Teams client configuration (guest access)',
                     desired='AllowGuestUser per -Mode',
                     test='$State.AllowGuestUser -eq $allowGuest'),
         cmdlet_step(get='Get-CsTeamsGuestCallingConfiguration -Identity Global', setcmd='Set-CsTeamsGuestCallingConfiguration -Identity Global',
                     expected={'AllowPrivateCalling': False}, target='Teams guest calling configuration',
                     test="$Mode -eq 'Disable' -or $State.AllowPrivateCalling -eq $false"),
         cmdlet_step(get='Get-CsTeamsGuestMeetingConfiguration -Identity Global', setcmd='Set-CsTeamsGuestMeetingConfiguration -Identity Global',
                     expected={'AllowIPVideo': False, 'ScreenSharingMode': 'Disabled', 'AllowMeetNow': False},
                     target='Teams guest meeting configuration',
                     test="$Mode -eq 'Disable' -or (Test-RemediationProperty -State $State -Expected @{ AllowIPVideo = $false; ScreenSharingMode = 'Disabled'; AllowMeetNow = $false })"),
         cmdlet_step(get='Get-CsTeamsGuestMessagingConfiguration -Identity Global', setcmd='Set-CsTeamsGuestMessagingConfiguration -Identity Global',
                     expected={'AllowUserEditMessage': False, 'AllowUserDeleteMessage': False, 'AllowUserChat': True},
                     target='Teams guest messaging configuration',
                     test="$Mode -eq 'Disable' -or (Test-RemediationProperty -State $State -Expected @{ AllowUserEditMessage = $false; AllowUserDeleteMessage = $false; AllowUserChat = $true })"),
     ],
     prelude="$allowGuest = $Mode -eq 'Restrict'")

emit('TEAMS-APPS-002',
     desc='Sets the Global Teams app permission policy so third-party apps are blocked, or allowed\nonly from an approved list. Microsoft and custom (org) apps are not changed.',
     desired='Third-party apps blocked, or limited to -AllowedAppId',
     services=['Teams'],
     params=[('AllowedAppId', "[Parameter()]\n[string[]]",
              'Teams app IDs (from the Teams admin center or Get-TeamsApp) of approved third-party apps.\nOmit to block all third-party apps.')],
     notes='Tenants migrated to app-centric management manage app availability per app in the Teams\nadmin center instead; in that case Set-CsTeamsAppPermissionPolicy is rejected and this script\nreports Failed. Use Teams admin center > Manage apps for those tenants.',
     prelude="$apps = @($AllowedAppId | Where-Object { $_ } | ForEach-Object {\n    New-Object -TypeName 'Microsoft.Teams.Policy.Administration.Cmdlets.Core.GlobalCatalogApp' -Property @{ Id = $_ }\n})",
     steps=[dict(target='Teams app permission policy Global', desired='Third-party (global catalog) apps restricted',
                 get='Get-CsTeamsAppPermissionPolicy -Identity Global',
                 test="$current = @($State.GlobalCatalogApps | ForEach-Object { $_.Id } | Sort-Object)\n$State.GlobalCatalogAppsType -eq 'AllowedAppList' -and ($current -join ',') -eq (@($AllowedAppId | Where-Object { $_ } | Sort-Object) -join ',')",
                 set="Set-CsTeamsAppPermissionPolicy -Identity Global -GlobalCatalogAppsType AllowedAppList -GlobalCatalogApps $apps")])

cmdlet_props('TEAMS-REPORTING-001', service='Teams', get='Get-CsTeamsMessagingPolicy -Identity Global',
             setcmd='Set-CsTeamsMessagingPolicy -Identity Global', target='Teams messaging policy Global',
             expected={'AllowSecurityEndUserReporting': True},
             desc='Lets users report messages as security concerns from Teams (Global messaging policy).',
             notes='Reported messages go to the destination set in the Defender user-reported settings\n(Set-ReportSubmissionPolicy -ReportChatMessageEnabled $true). Configure that separately.')
print('ok')
