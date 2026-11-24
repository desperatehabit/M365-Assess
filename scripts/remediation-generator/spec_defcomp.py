from gen import emit, cmdlet_props, cmdlet_step, graph_props

EXO = 'ExchangeOnline'
SCC = 'SecurityCompliance'
POL = lambda default: ('PolicyIdentity = ' + "'" + default + "'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]",
                       f"Policy to change. Defaults to the built-in default policy ('{default}').")
EMPTY = '$null -eq $State -or @($State).Count -eq 0'

# ---------------------------------------------------------------- Defender
cmdlet_props('DEFENDER-ANTIMALWARE-001', service=EXO, get='Get-MalwareFilterPolicy -Identity $PolicyIdentity',
             setcmd='Set-MalwareFilterPolicy -Identity $PolicyIdentity', target='"Anti-malware policy $PolicyIdentity"',
             expected={'EnableFileFilter': True}, params=[POL('Default')],
             desc='Turns on the common attachment types filter in the anti-malware policy.')

emit('DEFENDER-ANTIMALWARE-002',
     desc='Turns on admin notification when an internal sender sends malware.',
     desired='EnableInternalSenderAdminNotifications = True, InternalSenderAdminAddress = -AdminAddress',
     services=[EXO],
     params=[POL('Default'), ('AdminAddress', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string]",
                              'Mailbox that receives the notifications (a security team mailbox).')],
     example_args="-AdminAddress 'secops@contoso.com'",
     steps=[cmdlet_step(get='Get-MalwareFilterPolicy -Identity $PolicyIdentity', setcmd='Set-MalwareFilterPolicy -Identity $PolicyIdentity',
                        expected={'EnableInternalSenderAdminNotifications': True, 'InternalSenderAdminAddress': '$AdminAddress'},
                        target='"Anti-malware policy $PolicyIdentity"')])

FILETYPES = ['ace', 'ani', 'apk', 'app', 'cab', 'cmd', 'com', 'deb', 'dmg', 'exe', 'hta', 'img', 'iso', 'jar', 'js', 'jse',
             'lnk', 'msi', 'pif', 'ps1', 'reg', 'rgs', 'scr', 'sct', 'vb', 'vbe', 'vbs', 'vhd', 'vxd', 'wsc', 'wsf', 'wsh']
emit('DEFENDER-MALWARE-002',
     desc='Adds the CIS list of dangerous file types to the anti-malware policy\'s common attachments\nfilter (keeping any types already blocked) and turns on the filter and ZAP.',
     desired='EnableFileFilter and ZapEnabled on; FileTypes includes every CIS high-risk extension',
     services=[EXO], params=[POL('Default')],
     prelude="$requiredTypes = @(\n    " + ",\n    ".join(", ".join("'" + t + "'" for t in FILETYPES[i:i + 8]) for i in range(0, len(FILETYPES), 8)) + "\n)",
     steps=[dict(target='"Anti-malware policy $PolicyIdentity"', desired='Comprehensive attachment filter',
                 get='Get-MalwareFilterPolicy -Identity $PolicyIdentity',
                 test="$types = @($State.FileTypes)\n$State.EnableFileFilter -eq $true -and $State.ZapEnabled -eq $true -and @($requiredTypes | Where-Object { $types -notcontains $_ }).Count -eq 0",
                 set="$types = @(@($State.FileTypes) + $requiredTypes | Where-Object { $_ } | Sort-Object -Unique)\nSet-MalwareFilterPolicy -Identity $PolicyIdentity -EnableFileFilter $true -ZapEnabled $true -FileTypes $types")])

emit('DEFENDER-ANTIPHISH-001',
     desc='Applies the settings the anti-phishing check looks for to the default policy: phishing\nthreshold 2 (aggressive) or higher, mailbox intelligence and its protection, spoof intelligence,\nhonor DMARC, first-contact safety tips, organization-domain protection, and optionally\nuser impersonation protection.',
     desired='Default anti-phishing policy meets the check',
     services=[EXO],
     params=[POL('Office365 AntiPhish Default'),
             ('ProtectedUser', "[Parameter()]\n[string[]]", "Users to protect from impersonation, in 'Display Name;address@domain' form.\nOmit to leave targeted user protection unchanged.")],
     notes='Policies managed by a preset security policy are already compliant and are not changed.',
     prelude="$expected = @{\n    EnableMailboxIntelligence           = $true\n    EnableMailboxIntelligenceProtection = $true\n    EnableSpoofIntelligence             = $true\n    HonorDmarcPolicy                    = $true\n    EnableFirstContactSafetyTips        = $true\n    EnableOrganizationDomainsProtection = $true\n}\nif (@($ProtectedUser | Where-Object { $_ }).Count -gt 0) {\n    $expected['EnableTargetedUserProtection'] = $true\n    $expected['TargetedUsersToProtect'] = @($ProtectedUser)\n}",
     steps=[dict(target='"Anti-phishing policy $PolicyIdentity"', desired='Meets anti-phishing check',
                 get='Get-AntiPhishPolicy -Identity $PolicyIdentity',
                 test='(Test-RemediationProperty -State $State -Expected $expected) -and $null -ne $State.PhishThresholdLevel -and [int]$State.PhishThresholdLevel -ge 2',
                 set="$settings = $expected.Clone()\nif ($null -eq $State.PhishThresholdLevel -or [int]$State.PhishThresholdLevel -lt 2) { $settings['PhishThresholdLevel'] = 2 }\nSet-AntiPhishPolicy -Identity $PolicyIdentity @settings")])

emit('DEFENDER-ANTISPAM-001',
     desc='Applies the settings the anti-spam check looks for to the default inbound policy: BCL\nthreshold 6 or lower, spam to Junk or Quarantine, high-confidence spam / phish / phishing to\nQuarantine, and spam and phish ZAP on.',
     desired='Default anti-spam policy meets the check',
     services=[EXO], params=[POL('Default')],
     notes='Existing stricter values (a lower BCL threshold, spam to Quarantine) are kept.',
     prelude="$expected = @{\n    HighConfidenceSpamAction  = 'Quarantine'\n    HighConfidencePhishAction = 'Quarantine'\n    PhishSpamAction           = 'Quarantine'\n    SpamZapEnabled            = $true\n    PhishZapEnabled           = $true\n}",
     steps=[dict(target='"Anti-spam policy $PolicyIdentity"', desired='Meets anti-spam check',
                 get='Get-HostedContentFilterPolicy -Identity $PolicyIdentity',
                 test="(Test-RemediationProperty -State $State -Expected $expected) -and\n@('MoveToJmf', 'Quarantine') -contains \"$($State.SpamAction)\" -and\n$null -ne $State.BulkThreshold -and [int]$State.BulkThreshold -le 6",
                 set="$settings = $expected.Clone()\nif (@('MoveToJmf', 'Quarantine') -notcontains \"$($State.SpamAction)\") { $settings['SpamAction'] = 'MoveToJmf' }\nif ($null -eq $State.BulkThreshold -or [int]$State.BulkThreshold -gt 6) { $settings['BulkThreshold'] = 6 }\nSet-HostedContentFilterPolicy -Identity $PolicyIdentity @settings")])

emit('DEFENDER-OUTBOUND-001',
     desc='Hardens the default outbound anti-spam policy: automatic forwarding off, and a copy of\nsuspicious outbound mail plus outbound-spam notifications sent to the address you choose.',
     desired='AutoForwardingMode Off; BccSuspiciousOutboundMail and NotifyOutboundSpam on',
     services=[EXO],
     params=[POL('Default'), ('NotifyAddress', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]",
                              'Mailbox(es) that receive the BCC copies and outbound spam notifications.')],
     example_args="-NotifyAddress 'secops@contoso.com'",
     steps=[cmdlet_step(get='Get-HostedOutboundSpamFilterPolicy -Identity $PolicyIdentity',
                        setcmd='Set-HostedOutboundSpamFilterPolicy -Identity $PolicyIdentity',
                        expected={'AutoForwardingMode': 'Off', 'BccSuspiciousOutboundMail': True, 'BccSuspiciousOutboundAdditionalRecipients': '$NotifyAddress',
                                  'NotifyOutboundSpam': True, 'NotifyOutboundSpamRecipients': '$NotifyAddress'},
                        target='"Outbound spam filter policy $PolicyIdentity"')])

emit('DEFENDER-ANTISPAM-002',
     desc='Clears the allowed sender domains list on inbound anti-spam policies. Allowed domains skip\nspam filtering, which makes them a spoofing target.',
     desired='AllowedSenderDomains empty on every inbound anti-spam policy',
     services=[EXO],
     notes='Removed domains are returned in Before. Replace real needs with tenant allow/block list\nentries, which still get authentication checks.',
     steps=[dict(target='Inbound anti-spam policies with allowed sender domains', desired='None',
                 get="@(Get-HostedContentFilterPolicy | Where-Object { @($_.AllowedSenderDomains | Where-Object { $_ }).Count -gt 0 } |\n    Select-Object -Property Name, Identity, AllowedSenderDomains)",
                 test=EMPTY,
                 set="foreach ($policy in $State) {\n    Set-HostedContentFilterPolicy -Identity $policy.Identity -AllowedSenderDomains @{}\n}")])

cmdlet_props('DEFENDER-SAFEATTACH-002', service=EXO, get='Get-AtpPolicyForO365', setcmd='Set-AtpPolicyForO365',
             target='Defender for Office 365 global settings', expected={'EnableATPForSPOTeamsODB': True},
             desc='Turns on Safe Attachments for SharePoint, OneDrive, and Microsoft Teams.',
             notes='Requires Defender for Office 365 Plan 1 or 2.')
cmdlet_props('DEFENDER-ZAP-001', service=EXO, get='Get-AtpPolicyForO365', setcmd='Set-AtpPolicyForO365',
             target='Defender for Office 365 global settings', expected={'ZapEnabled': True},
             desc='Turns on zero-hour auto purge (ZAP) for Microsoft Teams messages.',
             notes='Requires Defender for Office 365 Plan 2 (or E5).')

DOMAINS = "$domains = if (@($RecipientDomain | Where-Object { $_ }).Count -gt 0) { @($RecipientDomain) } else { @(Get-AcceptedDomain | ForEach-Object { \"$($_.DomainName)\" }) }"
emit('DEFENDER-SAFELINKS-001',
     desc='Creates (or updates) a Safe Links policy and rule covering every accepted domain, with URL\nscanning for email, Teams, and Office apps, click tracking, internal-sender coverage, and\ndelivery held until scanning completes.',
     desired='Safe Links policy enabled for all recipients',
     services=[EXO],
     params=[("PolicyName = 'Safe Links'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the policy and rule to create or update.'),
             ('RecipientDomain', "[Parameter()]\n[string[]]", 'Recipient domains the rule covers. Defaults to every accepted domain.')],
     notes='Requires Defender for Office 365. Tenants using the Standard or Strict preset already get\nSafe Links from the preset; this adds a custom policy alongside it.',
     prelude=DOMAINS + "\n$expected = @{\n    EnableSafeLinksForEmail  = $true\n    EnableSafeLinksForTeams  = $true\n    EnableSafeLinksForOffice = $true\n    ScanUrls                 = $true\n    TrackClicks              = $true\n    EnableForInternalSenders = $true\n    DeliverMessageAfterScan  = $true\n}",
     steps=[dict(target='"Safe Links policy $PolicyName"', desired='Enabled with recommended settings',
                 get='Get-SafeLinksPolicy -Identity $PolicyName -ErrorAction SilentlyContinue',
                 test='Test-RemediationProperty -State $State -Expected $expected',
                 set="if ($null -eq $State) { New-SafeLinksPolicy -Name $PolicyName @expected | Out-Null }\nelse { Set-SafeLinksPolicy -Identity $PolicyName @expected }"),
            dict(target='"Safe Links rule $PolicyName"', desired='Enabled for all target domains',
                 get='Get-SafeLinksRule -Identity $PolicyName -ErrorAction SilentlyContinue',
                 test="$null -ne $State -and $State.State -eq 'Enabled' -and (@($domains | Where-Object { @($State.RecipientDomainIs) -notcontains $_ }).Count -eq 0)",
                 set="if ($null -eq $State) { New-SafeLinksRule -Name $PolicyName -SafeLinksPolicy $PolicyName -RecipientDomainIs $domains | Out-Null }\nelse {\n    Set-SafeLinksRule -Identity $PolicyName -RecipientDomainIs $domains\n    if ($State.State -ne 'Enabled') { Enable-SafeLinksRule -Identity $PolicyName -Confirm:$false }\n}")])

emit('DEFENDER-SAFEATTACH-001',
     desc='Creates (or updates) a Safe Attachments policy and rule covering every accepted domain, with\nthe Block action and optional redirection of detected attachments to a security mailbox.',
     desired='Safe Attachments policy enabled (Block) for all recipients',
     services=[EXO],
     params=[("PolicyName = 'Safe Attachments'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the policy and rule to create or update.'),
             ('RecipientDomain', "[Parameter()]\n[string[]]", 'Recipient domains the rule covers. Defaults to every accepted domain.'),
             ('RedirectAddress', "[Parameter()]\n[string]", 'Mailbox that receives a copy of detected attachments. Omit to leave redirection off.')],
     notes='Requires Defender for Office 365.',
     prelude=DOMAINS + "\n$expected = @{\n    Enable = $true\n    Action = 'Block'\n}\nif (-not [string]::IsNullOrWhiteSpace($RedirectAddress)) {\n    $expected['Redirect'] = $true\n    $expected['RedirectAddress'] = $RedirectAddress\n}",
     steps=[dict(target='"Safe Attachments policy $PolicyName"', desired='Enabled, Block',
                 get='Get-SafeAttachmentPolicy -Identity $PolicyName -ErrorAction SilentlyContinue',
                 test='Test-RemediationProperty -State $State -Expected $expected',
                 set="if ($null -eq $State) { New-SafeAttachmentPolicy -Name $PolicyName @expected | Out-Null }\nelse { Set-SafeAttachmentPolicy -Identity $PolicyName @expected }"),
            dict(target='"Safe Attachments rule $PolicyName"', desired='Enabled for all target domains',
                 get='Get-SafeAttachmentRule -Identity $PolicyName -ErrorAction SilentlyContinue',
                 test="$null -ne $State -and $State.State -eq 'Enabled' -and (@($domains | Where-Object { @($State.RecipientDomainIs) -notcontains $_ }).Count -eq 0)",
                 set="if ($null -eq $State) { New-SafeAttachmentRule -Name $PolicyName -SafeAttachmentPolicy $PolicyName -RecipientDomainIs $domains | Out-Null }\nelse {\n    Set-SafeAttachmentRule -Identity $PolicyName -RecipientDomainIs $domains\n    if ($State.State -ne 'Enabled') { Enable-SafeAttachmentRule -Identity $PolicyName -Confirm:$false }\n}")])

PRESET_NOTE = ('The preset policies (and their rules) only exist after the preset has been turned on once in\n'
               'the Defender portal (Email & collaboration > Policies & rules > Threat policies > Preset\n'
               'security policies). If the rule is missing, this script reports Failed with that instruction.')


def preset(cid, tier, desc, params, scope_prelude, example):
    rule = f'{tier} Preset Security Policy'
    emit(cid, desc=desc, desired=f'{tier} preset applied to the chosen recipients', services=[EXO], params=params,
         notes=PRESET_NOTE + '\nRecipients already assigned are replaced by the ones you pass.',
         example_args=example,
         prelude=scope_prelude,
         steps=[dict(target=f'"EOP {tier.lower()} preset rule"', desired='Enabled for chosen recipients',
                     get=f"$rule = Get-EOPProtectionPolicyRule -Identity '{rule}' -ErrorAction SilentlyContinue\nif ($null -eq $rule) {{ throw 'The {tier} preset security policy has not been turned on yet. Turn it on once in the Defender portal, then re-run.' }}\n$rule",
                     test="$State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected $scope)",
                     set=f"Set-EOPProtectionPolicyRule -Identity '{rule}' @scope\nif ($State.State -ne 'Enabled') {{ Enable-EOPProtectionPolicyRule -Identity '{rule}' -Confirm:$false }}"),
                dict(target=f'"Defender for Office 365 {tier.lower()} preset rule"', desired='Enabled for chosen recipients (if licensed)',
                     get=f"Get-ATPProtectionPolicyRule -Identity '{rule}' -ErrorAction SilentlyContinue",
                     test="$null -eq $State -or ($State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected $scope))",
                     set=f"Set-ATPProtectionPolicyRule -Identity '{rule}' @scope\nif ($State.State -ne 'Enabled') {{ Enable-ATPProtectionPolicyRule -Identity '{rule}' -Confirm:$false }}")])


preset('DEFENDER-PRIORITY-001', 'Standard',
       'Applies the Standard preset security policy (EOP and, where licensed, Defender for Office 365)\nto all recipients in the domains you choose, as the org-wide protection baseline.',
       [('RecipientDomain', "[Parameter()]\n[string[]]", 'Domains the preset covers. Defaults to every accepted domain.')],
       DOMAINS + "\n$scope = @{ RecipientDomainIs = $domains }", '')
preset('DEFENDER-PRIORITY-002', 'Strict',
       'Applies the Strict preset security policy to your priority accounts (executives, finance,\nIT admins) so they get the most aggressive filtering.',
       [('PriorityUser', "[Parameter()]\n[string[]]", 'Priority users (email addresses).'),
        ('PriorityGroup', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Groups whose members are priority accounts (for example a "Priority Accounts" group).')],
       "$scope = @{}\nif (@($PriorityUser | Where-Object { $_ }).Count -gt 0) { $scope['SentTo'] = @($PriorityUser) }\nif (@($PriorityGroup | Where-Object { $_ }).Count -gt 0) { $scope['SentToMemberOf'] = @($PriorityGroup) }",
       "-PriorityGroup 'Priority Accounts'")

emit('DEFENDER-REALTIMESCAN-001',
     desc='Creates an Intune device restriction profile (Windows 10/11) that turns on Microsoft Defender\nAntivirus real-time protection and scanning of all files, and assigns it.',
     desired='Intune profile with real-time monitoring of all files, assigned',
     services=['Graph'], scopes=['DeviceManagementConfiguration.ReadWrite.All'],
     params=[("ProfileName = 'Defender Antivirus - Real-time protection'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Display name of the profile to create or update.'),
             ('AssignToGroupId', "[Parameter(Mandatory, ParameterSetName = 'Group')]\n[string[]]", 'Entra group object IDs to assign the profile to.'),
             ('AssignToAllDevices', "[Parameter(Mandatory, ParameterSetName = 'AllDevices')]\n[switch]", 'Assign the profile to all devices.')],
     example_args='-AssignToAllDevices',
     notes='Uses the device restrictions (windows10GeneralConfiguration) profile type that the\nassessment reads. If you already manage antivirus with an Endpoint security policy, assign\nthat instead; the collector also accepts it.',
     prelude="$profileBody = @{\n    '@odata.type'                     = '#microsoft.graph.windows10GeneralConfiguration'\n    displayName                       = $ProfileName\n    description                       = 'Created by M365-Assess remediation DEFENDER-REALTIMESCAN-001'\n    defenderRequireRealTimeMonitoring = $true\n    defenderMonitorFileActivity       = 'monitorAllFiles'\n    defenderRealtimeScanDirection     = 'monitorAllFiles'\n}\n$targets = if ($AssignToAllDevices.IsPresent) {\n    @(@{ target = @{ '@odata.type' = '#microsoft.graph.allDevicesAssignmentTarget' } })\n}\nelse {\n    @($AssignToGroupId | ForEach-Object { @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $_ } } })\n}\n$filterName = $ProfileName.Replace(\"'\", \"''\")",
     steps=[dict(target='"Intune profile $ProfileName"', desired='Exists with real-time monitoring and is assigned',
                 get="$found = (Invoke-MgGraphRequest -Method GET -Uri \"/beta/deviceManagement/deviceConfigurations?`$filter=displayName eq '$filterName'&`$expand=assignments\" -OutputType HashTable)['value'] | Select-Object -First 1\n$found",
                 test="$null -ne $State -and $State['defenderMonitorFileActivity'] -eq 'monitorAllFiles' -and @($State['assignments']).Count -gt 0",
                 set="$id = if ($null -eq $State) {\n    (Invoke-MgGraphRequest -Method POST -Uri '/beta/deviceManagement/deviceConfigurations' -Body ($profileBody | ConvertTo-Json -Depth 10) -ContentType 'application/json' -OutputType HashTable)['id']\n}\nelse {\n    $patch = $profileBody.Clone()\n    $patch.Remove('displayName')\n    Invoke-MgGraphRequest -Method PATCH -Uri \"/beta/deviceManagement/deviceConfigurations/$($State['id'])\" -Body ($patch | ConvertTo-Json -Depth 10) -ContentType 'application/json'\n    $State['id']\n}\nInvoke-MgGraphRequest -Method POST -Uri \"/beta/deviceManagement/deviceConfigurations/$id/assign\" -Body (@{ assignments = $targets } | ConvertTo-Json -Depth 10) -ContentType 'application/json'")])

# ---------------------------------------------------------------- Compliance
for cid in ('COMPLIANCE-AUDIT-001', 'PURVIEW-AUDIT-001'):
    cmdlet_props(cid, service=EXO, get='Get-AdminAuditLogConfig', setcmd='Set-AdminAuditLogConfig',
                 target='Unified audit log ingestion', expected={'UnifiedAuditLogIngestionEnabled': True},
                 desc='Turns on unified audit log ingestion (audit log search).',
                 notes='Run from Exchange Online PowerShell. It can take up to 60 minutes for search to work after\nturning this on.')

emit('COMPLIANCE-ALERTPOLICY-001',
     desc='Re-enables built-in (system) alert policies of high severity that have been turned off, such\nas suspicious activity, malware, and elevation of privilege alerts.',
     desired='No disabled high-severity system alert policies',
     services=[SCC],
     params=[("Severity = 'High'", "[Parameter()]\n[ValidateSet('High', 'Medium', 'Low', 'Informational')]\n[string[]]", 'Severities to re-enable. Defaults to High.')],
     steps=[dict(target='Disabled system alert policies', desired='All enabled',
                 get="@(Get-ProtectionAlert | Where-Object { $_.Disabled -eq $true -and $_.IsSystemRule -eq $true -and @($Severity) -contains \"$($_.Severity)\" } |\n    Select-Object -Property Name, Identity, Severity, Disabled)",
                 test=EMPTY,
                 set="foreach ($alert in $State) {\n    Set-ProtectionAlert -Identity $alert.Identity -Disabled $false\n}")])

SIT = ('SensitiveInformationType', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]",
       "Sensitive information type names to detect, e.g. 'Credit Card Number',\n'U.S. Social Security Number (SSN)'. List them with Get-DlpSensitiveInformationType.")
MODE = ("Mode = 'TestWithoutNotifications'", "[Parameter()]\n[ValidateSet('TestWithoutNotifications', 'TestWithNotifications', 'Enable')]\n[string]",
        'Policy mode. Defaults to simulation without notifications; switch to Enable after review.')


def dlp(cid, desc, locations, test_extra):
    loc = '\n'.join(f'    {k} = \'All\'' for k in locations)
    emit(cid, desc=desc, desired='Enabled DLP policy covering ' + ', '.join(x.replace('Location', '') for x in locations),
         services=[SCC],
         params=[("PolicyName = 'M365-Assess baseline DLP'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the DLP policy to create or update.'),
                 SIT, MODE,
                 ('BlockAccess', "[Parameter()]\n[switch]", 'Block access to matching content (otherwise matches are only reported).')],
         example_args="-SensitiveInformationType 'Credit Card Number'",
         notes='Created in simulation mode by default. Review matches in Activity explorer before\nswitching -Mode to Enable.',
         prelude=f"$locations = @{{\n{loc}\n}}\n$sitList = @($SensitiveInformationType | ForEach-Object {{ @{{ Name = $_ }} }})",
         steps=[dict(target='"DLP policy $PolicyName"', desired='Exists, enabled, covers the locations',
                     get='Get-DlpCompliancePolicy -Identity $PolicyName -ErrorAction SilentlyContinue',
                     test=f"$null -ne $State -and $State.Enabled -eq $true -and {test_extra}",
                     set="if ($null -eq $State) {\n    New-DlpCompliancePolicy -Name $PolicyName -Mode $Mode @locations | Out-Null\n}\nelse {\n    $add = @{}\n    foreach ($key in $locations.Keys) { $add[\"Add$key\"] = 'All' }\n    Set-DlpCompliancePolicy -Identity $PolicyName -Mode $Mode -Enabled $true @add\n}"),
                dict(target='"DLP rule $PolicyName rule"', desired='Rule detecting the chosen sensitive information types',
                     get='Get-DlpComplianceRule -Policy $PolicyName -ErrorAction SilentlyContinue | Select-Object -First 1',
                     test='$null -ne $State',
                     set="New-DlpComplianceRule -Name \"$PolicyName rule\" -Policy $PolicyName -ContentContainsSensitiveInformation $sitList -BlockAccess $BlockAccess.IsPresent | Out-Null")])


dlp('COMPLIANCE-DLP-001', 'Creates a DLP policy across Exchange, SharePoint, OneDrive, and Teams with a rule for the\nsensitive information types you choose.',
    ['ExchangeLocation', 'SharePointLocation', 'OneDriveLocation', 'TeamsLocation'], '$true')
dlp('COMPLIANCE-DLP-002', 'Creates (or extends) a DLP policy so it covers Teams chat and channel messages.',
    ['TeamsLocation'], '@($State.TeamsLocation).Count -gt 0')
dlp('COMPLIANCE-DLP-003', 'Creates (or extends) a DLP policy so it covers Exchange email and SharePoint/OneDrive.',
    ['ExchangeLocation', 'SharePointLocation', 'OneDriveLocation'],
    '@($State.ExchangeLocation).Count -gt 0 -and (@($State.SharePointLocation).Count -gt 0 -or @($State.OneDriveLocation).Count -gt 0)')

emit('COMPLIANCE-LABELS-001',
     desc='Publishes existing sensitivity labels to users with a label policy, creating any listed\nlabels that do not exist yet (as plain labels with no protection settings).',
     desired='A label policy publishes -LabelName',
     services=[SCC],
     params=[('LabelName', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", "Labels to publish, e.g. 'Public', 'General', 'Confidential'."),
             ("PolicyName = 'M365-Assess baseline labels'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the label policy.'),
             ('CreateMissingLabel', "[Parameter()]\n[switch]", 'Create labels from -LabelName that do not exist. Without it, missing labels fail the step.')],
     example_args="-LabelName 'Public', 'General', 'Confidential' -CreateMissingLabel",
     notes='Configure encryption, marking, and scope on the labels themselves in the Purview portal.\nPublished labels can take up to 24 hours to appear in apps.',
     steps=[dict(target='Sensitivity labels', desired='All of -LabelName exist',
                 get="$existing = @(Get-Label | ForEach-Object { \"$($_.Name)\" })\n@($LabelName | Where-Object { $existing -notcontains $_ })",
                 test=EMPTY,
                 set="if (-not $CreateMissingLabel.IsPresent) { throw \"Labels not found: $($State -join ', '). Create them or pass -CreateMissingLabel.\" }\nforeach ($name in $State) { New-Label -Name $name -DisplayName $name -Tooltip $name | Out-Null }"),
            dict(target='"Label policy $PolicyName"', desired='Publishes the labels to all users',
                 get='Get-LabelPolicy -Identity $PolicyName -ErrorAction SilentlyContinue',
                 test="$null -ne $State -and @($LabelName | Where-Object { @($State.Labels) -notcontains $_ -and @($State.ScopedLabels) -notcontains $_ }).Count -eq 0",
                 set="if ($null -eq $State) { New-LabelPolicy -Name $PolicyName -Labels $LabelName -ExchangeLocation All | Out-Null }\nelse { Set-LabelPolicy -Identity $PolicyName -AddLabels $LabelName }")])

emit('COMPLIANCE-LABELS-002',
     desc='Creates an auto-labeling policy that applies a sensitivity label to content containing the\nsensitive information types you choose, across Exchange, SharePoint, and OneDrive. Created in\nsimulation mode.',
     desired='Enabled auto-labeling policy',
     services=[SCC],
     params=[('LabelName', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string]", 'Existing sensitivity label to apply.'),
             SIT,
             ("PolicyName = 'M365-Assess auto-labeling'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the auto-labeling policy.'),
             ("Mode = 'TestWithoutNotifications'", "[Parameter()]\n[ValidateSet('TestWithoutNotifications', 'TestWithNotifications', 'Enable')]\n[string]", 'Defaults to simulation; switch to Enable after review.')],
     example_args="-LabelName 'Confidential' -SensitiveInformationType 'Credit Card Number'",
     notes='Requires Microsoft 365 E5 / E5 Compliance (or Information Protection P2).',
     prelude="$sitList = @($SensitiveInformationType | ForEach-Object { @{ Name = $_ } })",
     steps=[dict(target='"Auto-labeling policy $PolicyName"', desired='Exists and enabled',
                 get='Get-AutoSensitivityLabelPolicy -Identity $PolicyName -ErrorAction SilentlyContinue',
                 test='$null -ne $State -and $State.Enabled -eq $true',
                 set="if ($null -eq $State) {\n    New-AutoSensitivityLabelPolicy -Name $PolicyName -ApplySensitivityLabel $LabelName -ExchangeLocation All -SharePointLocation All -OneDriveLocation All -Mode $Mode | Out-Null\n    foreach ($workload in @('Exchange', 'SharePoint', 'OneDriveForBusiness')) {\n        New-AutoSensitivityLabelRule -Name \"$PolicyName $workload\" -Policy $PolicyName -Workload $workload -ContentContainsSensitiveInformation $sitList | Out-Null\n    }\n}\nelse {\n    Set-AutoSensitivityLabelPolicy -Identity $PolicyName -Enabled $true -Mode $Mode\n}")])

emit('COMPLIANCE-COMMS-001',
     desc='Creates a communication compliance policy that reviews Exchange and Teams messages from the\nmonitored users/groups for offensive or harassing language, with the reviewers you name.',
     desired='Enabled communication compliance policy',
     services=[SCC],
     params=[('Reviewer', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Reviewers (email addresses). They also need the Communication Compliance role.'),
             ('MonitoredGroup', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Distribution or Microsoft 365 group addresses whose members are monitored.'),
             ("PolicyName = 'M365-Assess communication compliance'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Policy name.'),
             ("SamplingRate = 100", "[Parameter()]\n[ValidateRange(1, 100)]\n[int]", 'Percentage of matching messages sent for review.')],
     example_args="-Reviewer 'hr-review@contoso.com' -MonitoredGroup 'allstaff@contoso.com'",
     notes='Uses the SupervisoryReviewPolicyV2 / SupervisoryReviewRule cmdlets that back Communication\ncompliance. Requires E5 / E5 Compliance or Insider Risk add-on. Communication compliance has\nprivacy and works-council implications; agree scope with HR and legal first.',
     steps=[dict(target='"Communication compliance policy $PolicyName"', desired='Exists and enabled',
                 get='Get-SupervisoryReviewPolicyV2 -Identity $PolicyName -ErrorAction SilentlyContinue',
                 test='$null -ne $State -and $State.Enabled -ne $false',
                 set="if ($null -eq $State) {\n    New-SupervisoryReviewPolicyV2 -Name $PolicyName -Reviewers $Reviewer | Out-Null\n    $condition = '(' + (@($MonitoredGroup | ForEach-Object { \"Reviewee:$_\" }) -join ' -OR ') + ')'\n    New-SupervisoryReviewRule -Name \"$PolicyName rule\" -Policy $PolicyName -SamplingRate $SamplingRate -Condition $condition -ContentSources 'Exchange', 'Teams' | Out-Null\n}\nelse {\n    Set-SupervisoryReviewPolicyV2 -Identity $PolicyName -Enabled $true\n}")])


# ---------------------------------------------------------------- Purview retention
def retention(cid, desc, locations, policy_default, test_extra, collector='PurviewRetention'):
    loc = '\n'.join(f'    {k} = \'All\'' for k in locations)
    emit(cid, desc=desc, desired='Enabled retention policy covering ' + ', '.join(locations),
         services=[SCC],
         params=[(f"PolicyName = '{policy_default}'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the retention policy to create or update.'),
                 ('RetentionDays', "[Parameter(Mandatory)]\n[ValidateRange(1, 36500)]\n[int]", 'How long to retain content, in days (e.g. 2555 for 7 years).'),
                 ("RetentionAction = 'Keep'", "[Parameter()]\n[ValidateSet('Keep', 'KeepAndDelete', 'Delete')]\n[string]",
                  'Keep (default) retains content for the period; KeepAndDelete deletes it afterwards.')],
         example_args='-RetentionDays 2555',
         notes='KeepAndDelete and Delete permanently remove content at the end of the period. Retention\nperiods are a legal and records-management decision; agree them before running.',
         prelude=f"$locations = @{{\n{loc}\n}}",
         steps=[dict(target='"Retention policy $PolicyName"', desired='Exists, enabled, covers the locations',
                     get='Get-RetentionCompliancePolicy -Identity $PolicyName -ErrorAction SilentlyContinue',
                     test=f"$null -ne $State -and $State.Enabled -ne $false -and {test_extra}",
                     set="if ($null -eq $State) {\n    New-RetentionCompliancePolicy -Name $PolicyName @locations | Out-Null\n}\nelse {\n    $add = @{}\n    foreach ($key in $locations.Keys) { $add[\"Add$key\"] = 'All' }\n    Set-RetentionCompliancePolicy -Identity $PolicyName -Enabled $true @add\n}"),
                dict(target='"Retention rule for $PolicyName"', desired='"Retain $RetentionDays days ($RetentionAction)"',
                     get='Get-RetentionComplianceRule -Policy $PolicyName -ErrorAction SilentlyContinue | Select-Object -First 1',
                     test='$null -ne $State',
                     set=("$ruleParams = @{\n    Name                       = \"$PolicyName rule\"\n    Policy                     = $PolicyName\n    RetentionDuration          = $RetentionDays\n    RetentionComplianceAction  = $RetentionAction\n}\n"
                          + ("$ruleParams['ExpirationDateOption'] = 'CreationAgeInDays'\n" if 'Teams' not in locations[0] else '')
                          + "New-RetentionComplianceRule @ruleParams | Out-Null"))])


retention('PURVIEW-RETENTION-001', 'Creates a retention policy covering Exchange, SharePoint, and OneDrive.',
          ['ExchangeLocation', 'SharePointLocation', 'OneDriveLocation'], 'M365-Assess baseline retention', '$true')
retention('PURVIEW-RETENTION-002', 'Creates (or extends) a retention policy so it covers Exchange email and mailboxes.',
          ['ExchangeLocation'], 'M365-Assess Exchange retention', '@($State.ExchangeLocation).Count -gt 0')
retention('PURVIEW-RETENTION-003', 'Creates (or extends) a retention policy for Teams channel messages and chats. Teams\nlocations need their own policy; they cannot be combined with Exchange or SharePoint.',
          ['TeamsChannelLocation', 'TeamsChatLocation'], 'M365-Assess Teams retention',
          '(@($State.TeamsChannelLocation).Count -gt 0 -or @($State.TeamsChatLocation).Count -gt 0)')
retention('PURVIEW-RETENTION-004', 'Creates (or extends) a retention policy so it covers SharePoint sites and OneDrive accounts.',
          ['SharePointLocation', 'OneDriveLocation'], 'M365-Assess SharePoint retention',
          '(@($State.SharePointLocation).Count -gt 0 -or @($State.OneDriveLocation).Count -gt 0)')

emit('PURVIEW-RETENTION-005',
     desc='Switches enabled retention policies that are still in simulation (Mode other than Enforce)\nto enforced.',
     desired='Every enabled retention policy is in Enforce mode',
     services=[SCC],
     params=[('PolicyName', "[Parameter()]\n[string[]]", 'Limit to these policies. Defaults to every enabled policy not in Enforce mode.')],
     notes='Enforcing a simulated policy starts retaining (and, for delete actions, deleting) content.\nReview each policy\'s simulation results first. The mode change is distributed\nasynchronously, so the step does not wait for Mode to read Enforce; re-run the assessment later.',
     steps=[dict(target='Retention policies not in Enforce mode', desired='None',
                 get="@(Get-RetentionCompliancePolicy | Where-Object {\n    $_.Enabled -ne $false -and $_.Mode -ne 'Enforce' -and\n    (@($PolicyName | Where-Object { $_ }).Count -eq 0 -or @($PolicyName) -contains $_.Name)\n} | Select-Object -Property Name, Identity, Mode)",
                 test=EMPTY,
                 set="foreach ($policy in $State) {\n    Set-RetentionCompliancePolicy -Identity $policy.Identity -EnforceSimulationPolicy $true\n}",
                 skipverify=True)])
print('ok')
