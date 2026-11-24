from gen import emit, cmdlet_props, cmdlet_step

EXO = 'ExchangeOnline'
ORG = dict(service=EXO, get='Get-OrganizationConfig', setcmd='Set-OrganizationConfig', target='Exchange organization config')

cmdlet_props('EXO-AUDIT-001', **ORG, expected={'AuditDisabled': False},
             desc='Turns on organization-wide mailbox auditing (AuditDisabled = False).',
             notes='This is a pre-condition for the unified audit log but does not turn it on; see\nCOMPLIANCE-AUDIT-001 for that.')
cmdlet_props('EXO-AUTH-001', **ORG, expected={'OAuth2ClientProfileEnabled': True},
             desc='Turns on modern authentication for Exchange Online clients.')
cmdlet_props('EXO-LOCKBOX-001', **ORG, expected={'CustomerLockBoxEnabled': True},
             desc='Turns on Customer Lockbox, so Microsoft engineers need your approval to access content.',
             notes='Requires Microsoft 365 E5, E5 Compliance, or the Customer Lockbox add-on. Without the\nlicense the change is rejected and the script reports Failed.')
cmdlet_props('EXO-MAILTIPS-001', **ORG,
             expected={'MailTipsAllTipsEnabled': True, 'MailTipsExternalRecipientsTipsEnabled': True, 'MailTipsGroupMetricsEnabled': True},
             desc='Turns on MailTips, including the external-recipient tip and group metrics.')
cmdlet_props('EXO-EXTTAG-001', service=EXO, get='Get-ExternalInOutlook', setcmd='Set-ExternalInOutlook',
             target='External sender tagging (External in Outlook)', expected={'Enabled': True},
             desc='Turns on the native "External" tag that Outlook shows on mail from outside the organization.',
             notes='Tags can take up to 48 hours to appear in clients.')

emit('EXO-FORWARD-001',
     desc='Blocks automatic forwarding to external recipients in both places Exchange Online enforces it:\nthe Default remote domain and the default outbound anti-spam policy.',
     desired='Remote domain Default AutoForwardEnabled = False; outbound spam policy AutoForwardingMode = Off',
     services=[EXO],
     notes='Mailboxes with an approved business need for external forwarding need a separate outbound\nspam policy scoped to them before you run this.',
     steps=[cmdlet_step(get='Get-RemoteDomain -Identity Default', setcmd='Set-RemoteDomain -Identity Default',
                        expected={'AutoForwardEnabled': False}, target='Remote domain Default'),
            cmdlet_step(get='Get-HostedOutboundSpamFilterPolicy -Identity Default',
                        setcmd='Set-HostedOutboundSpamFilterPolicy -Identity Default',
                        expected={'AutoForwardingMode': 'Off'}, target='Outbound spam filter policy Default')])

POL = lambda default: ('PolicyIdentity = ' + "'" + default + "'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]",
                       f"Policy to harden. Defaults to the built-in default policy ('{default}').")

cmdlet_props('EXO-CONNFILTER-002', service=EXO, get='Get-HostedConnectionFilterPolicy -Identity $PolicyIdentity',
             setcmd='Set-HostedConnectionFilterPolicy -Identity $PolicyIdentity', target='"Connection filter policy $PolicyIdentity"',
             expected={'EnableSafeList': False}, params=[POL('Default')],
             desc='Turns off the Microsoft-maintained connection filter safe list, so mail from those IPs\nis still spam-filtered.')

emit('EXO-CONNFILTER-001',
     desc='Empties the connection filter IP allow list. Allow-listed IPs skip spam filtering entirely.',
     desired='IPAllowList empty',
     services=[EXO], params=[POL('Default')],
     notes='The removed entries are returned in Before so they can be restored with\nSet-HostedConnectionFilterPolicy -IPAllowList. Replace legitimate needs with a\ntransport rule or an inbound connector scoped to those IPs before running.',
     steps=[dict(target='"Connection filter policy $PolicyIdentity IP allow list"', desired='Empty',
                 get='Get-HostedConnectionFilterPolicy -Identity $PolicyIdentity',
                 test='@($State.IPAllowList | Where-Object { $_ }).Count -eq 0',
                 set='Set-HostedConnectionFilterPolicy -Identity $PolicyIdentity -IPAllowList @{}')])

emit('EXO-ANTIPHISH-001',
     desc='Hardens the default anti-phishing policy: mailbox intelligence and its protection, spoof\nintelligence, organization-domain impersonation protection, first-contact safety tips, and\nQuarantine for impersonation and spoof detections. Optionally protects named users.',
     desired='Default anti-phishing policy hardened',
     services=[EXO],
     params=[POL('Office365 AntiPhish Default'),
             ('ProtectedUser', "[Parameter()]\n[string[]]",
              "Users to protect from impersonation, in 'Display Name;address@domain' form (executives,\nfinance). Omit to leave targeted user protection unchanged.")],
     prelude="$expected = @{\n    EnableMailboxIntelligence           = $true\n    EnableMailboxIntelligenceProtection = $true\n    MailboxIntelligenceProtectionAction = 'Quarantine'\n    EnableSpoofIntelligence             = $true\n    AuthenticationFailAction            = 'Quarantine'\n    EnableOrganizationDomainsProtection = $true\n    TargetedDomainProtectionAction      = 'Quarantine'\n    EnableFirstContactSafetyTips        = $true\n}\nif (@($ProtectedUser | Where-Object { $_ }).Count -gt 0) {\n    $expected['EnableTargetedUserProtection'] = $true\n    $expected['TargetedUsersToProtect'] = @($ProtectedUser)\n    $expected['TargetedUserProtectionAction'] = 'Quarantine'\n}",
     steps=[dict(target='"Anti-phishing policy $PolicyIdentity"', desired='Hardened settings',
                 get='Get-AntiPhishPolicy -Identity $PolicyIdentity',
                 test='Test-RemediationProperty -State $State -Expected $expected',
                 set='Set-AntiPhishPolicy -Identity $PolicyIdentity @expected')])

emit('EXO-ANTISPAM-001',
     desc='Hardens the default inbound anti-spam policy: spam to Junk, high-confidence spam and\nphishing to Quarantine, and a bulk complaint level (BCL) threshold of 6 or lower.',
     desired='SpamAction MoveToJmf, HighConfidenceSpamAction/PhishSpamAction/HighConfidencePhishAction Quarantine, BulkThreshold <= 6',
     services=[EXO], params=[POL('Default')],
     notes='A BulkThreshold already at 6 or lower is left as is.',
     prelude="$expected = @{\n    SpamAction                = 'MoveToJmf'\n    HighConfidenceSpamAction  = 'Quarantine'\n    PhishSpamAction           = 'Quarantine'\n    HighConfidencePhishAction = 'Quarantine'\n}",
     steps=[dict(target='"Anti-spam policy $PolicyIdentity"', desired='Hardened settings',
                 get='Get-HostedContentFilterPolicy -Identity $PolicyIdentity',
                 test='(Test-RemediationProperty -State $State -Expected $expected) -and $null -ne $State.BulkThreshold -and [int]$State.BulkThreshold -le 6',
                 set="$settings = $expected.Clone()\nif ($null -eq $State.BulkThreshold -or [int]$State.BulkThreshold -gt 6) { $settings['BulkThreshold'] = 6 }\nSet-HostedContentFilterPolicy -Identity $PolicyIdentity @settings")])

emit('EXO-MALWARE-001',
     desc='Hardens the default anti-malware policy: common attachment types filter and zero-hour auto\npurge (ZAP) on, and optionally admin notification for internal senders of malware.',
     desired='EnableFileFilter = True, ZapEnabled = True (+ admin notification when -AdminNotificationAddress is set)',
     services=[EXO],
     params=[POL('Default'),
             ('AdminNotificationAddress', "[Parameter()]\n[string]", 'Mailbox that is notified when an internal sender sends malware. Omit to leave\nnotifications unchanged.')],
     prelude="$expected = @{\n    EnableFileFilter = $true\n    ZapEnabled       = $true\n}\nif (-not [string]::IsNullOrWhiteSpace($AdminNotificationAddress)) {\n    $expected['EnableInternalSenderAdminNotifications'] = $true\n    $expected['InternalSenderAdminAddress'] = $AdminNotificationAddress\n}",
     steps=[dict(target='"Anti-malware policy $PolicyIdentity"', desired='Hardened settings',
                 get='Get-MalwareFilterPolicy -Identity $PolicyIdentity',
                 test='Test-RemediationProperty -State $State -Expected $expected',
                 set='Set-MalwareFilterPolicy -Identity $PolicyIdentity @expected')])

APPROLES = "@('My Marketplace Apps', 'My Custom Apps', 'My ReadWriteMailbox Apps')"
emit('EXO-ADDINS-001',
     desc='Removes the My Marketplace Apps, My Custom Apps, and My ReadWriteMailbox Apps roles from role\nassignment policies, so users can no longer install Outlook add-ins themselves.',
     desired='No add-in roles assigned through role assignment policies',
     services=[EXO],
     params=[('RoleAssignmentPolicy', "[Parameter()]\n[string[]]", 'Role assignment policies to change. Defaults to every role assignment policy.')],
     notes='Admins can still deploy add-ins centrally (Integrated Apps). The assessment check also\nflags MyBaseOptions, which this script deliberately leaves alone because removing it breaks\nbasic Outlook options for users; the check may stay at Review until that is fixed in the collector.',
     prelude=f"$addInRoles = {APPROLES}\n$policies = if (@($RoleAssignmentPolicy | Where-Object {{ $_ }}).Count -gt 0) {{ @($RoleAssignmentPolicy) }} else {{ @(Get-RoleAssignmentPolicy | ForEach-Object {{ $_.Name }}) }}",
     steps=[dict(target='"Add-in role assignments on: $($policies -join \', \')"', desired='None',
                 get="@(Get-ManagementRoleAssignment -RoleAssigneeType RoleAssignmentPolicy | Where-Object {\n    $addInRoles -contains \"$($_.Role)\" -and $policies -contains \"$($_.RoleAssigneeName)\"\n})",
                 test='$null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($assignment in $State) {\n    Remove-ManagementRoleAssignment -Identity $assignment.Identity -Confirm:$false\n}")])

emit('EXO-AUDIT-002',
     desc='Turns off audit bypass for every account that has it, so their mailbox actions are audited.',
     desired='No mailbox audit bypass associations enabled',
     services=[EXO],
     notes='Audit bypass is usually set for service accounts (backup, archiving) to reduce log volume.\nTurning it off increases audit volume for those accounts.',
     steps=[dict(target='Mailbox audit bypass associations', desired='None enabled',
                 get='@(Get-MailboxAuditBypassAssociation -ResultSize Unlimited -WarningAction SilentlyContinue | Where-Object { $_.AuditBypassEnabled -eq $true })',
                 test='$null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($association in $State) {\n    Set-MailboxAuditBypassAssociation -Identity $association.Identity -AuditBypassEnabled $false\n}")])

emit('EXO-AUDIT-003',
     desc='Turns on mailbox auditing (AuditEnabled) for every user and shared mailbox that has it off.',
     desired='AuditEnabled = True on all user and shared mailboxes',
     services=[EXO],
     notes='Default audit actions are applied by Exchange Online; this script does not change the\nper-mailbox audit action lists.',
     steps=[dict(target='Mailbox auditing (user and shared mailboxes)', desired='All enabled',
                 get="@(Get-Mailbox -ResultSize Unlimited -RecipientTypeDetails UserMailbox, SharedMailbox |\n    Where-Object { $_.AuditEnabled -ne $true } |\n    Select-Object -Property UserPrincipalName, Identity, AuditEnabled)",
                 test='$null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($mailbox in $State) {\n    Set-Mailbox -Identity $mailbox.Identity -AuditEnabled $true\n}")])

emit('EXO-OWA-001',
     desc='Turns off additional storage providers (Dropbox, Box, and similar) in every Outlook on the web\nmailbox policy that allows them.',
     desired='AdditionalStorageProvidersAvailable = False on every OWA mailbox policy',
     services=[EXO],
     steps=[dict(target='Outlook on the web mailbox policies', desired='No policy allows additional storage providers',
                 get='@(Get-OwaMailboxPolicy -WarningAction SilentlyContinue | Where-Object { $_.AdditionalStorageProvidersAvailable -eq $true } | Select-Object -Property Name, Identity, AdditionalStorageProvidersAvailable)',
                 test='$null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($policy in $State) {\n    Set-OwaMailboxPolicy -Identity $policy.Identity -AdditionalStorageProvidersAvailable $false\n}")])

emit('EXO-SHAREDMBX-001',
     desc='Blocks sign-in (accountEnabled = false) for the Entra user behind every shared mailbox.\nShared mailboxes are opened through delegated access, so their own sign-in is not needed.',
     desired='accountEnabled = false for every shared mailbox user',
     services=[EXO, 'Graph'], scopes=['User.ReadWrite.All'],
     notes='Shared mailboxes that are deliberately signed in to directly (some legacy apps or scanners)\nwill stop working; exclude them with -ExcludeMailbox.',
     params=[('ExcludeMailbox', "[Parameter()]\n[string[]]", 'User principal names of shared mailboxes to leave enabled.')],
     steps=[dict(target='Shared mailbox accounts', desired='Sign-in blocked',
                 get="@(Get-Mailbox -RecipientTypeDetails SharedMailbox -ResultSize Unlimited |\n    Where-Object { @($ExcludeMailbox) -notcontains $_.UserPrincipalName } |\n    ForEach-Object {\n        $user = Invoke-MgGraphRequest -Method GET -Uri \"/v1.0/users/$($_.ExternalDirectoryObjectId)?`$select=id,userPrincipalName,accountEnabled\" -OutputType HashTable\n        if ($user['accountEnabled'] -eq $true) { [PSCustomObject]@{ Id = $user['id']; UserPrincipalName = $user['userPrincipalName'] } }\n    })",
                 test='$null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($account in $State) {\n    Invoke-MgGraphRequest -Method PATCH -Uri \"/v1.0/users/$($account.Id)\" -Body (@{ accountEnabled = $false } | ConvertTo-Json) -ContentType 'application/json'\n}")])

emit('EXO-SHARING-001',
     desc='Removes the wildcard (*) entry from sharing policies so calendars cannot be shared with\nany external domain. Other domain entries are kept; a policy left with no entries is disabled.',
     desired='No sharing policy contains a * domain entry',
     services=[EXO],
     notes='Users lose the ability to share calendars with arbitrary external domains. Add specific\npartner domains to the policy afterwards if needed.',
     steps=[dict(target='Sharing policies', desired='No wildcard domain entries',
                 get="@(Get-SharingPolicy | Where-Object { (@($_.Domains) -join ';') -match '\\*' } | Select-Object -Property Name, Identity, Domains, Enabled)",
                 test='$null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($policy in $State) {\n    $remaining = @($policy.Domains | Where-Object { \"$_\" -notmatch '^\\*' })\n    if ($remaining.Count -gt 0) {\n        Set-SharingPolicy -Identity $policy.Identity -Domains $remaining\n    }\n    else {\n        Set-SharingPolicy -Identity $policy.Identity -Domains $null -Enabled $false\n    }\n}")])

# --- Needs decision -------------------------------------------------------
emit('EXO-AUTH-002',
     desc='Turns off SMTP AUTH client submission for the whole organization, then re-enables it only for\nthe mailboxes you list (devices or apps that still need it).',
     desired='SmtpClientAuthenticationDisabled = True org-wide; enabled only for -AllowMailbox',
     services=[EXO],
     params=[('AllowMailbox', "[Parameter()]\n[string[]]",
              'Mailboxes (UPN) that must keep SMTP AUTH, such as multifunction printers or line-of-business\napps. Find current users in the SMTP AUTH clients report before running.')],
     notes='Anything that sends through smtp.office365.com:587 with basic SMTP AUTH and is not listed in\n-AllowMailbox stops sending.',
     steps=[cmdlet_step(get='Get-TransportConfig', setcmd='Set-TransportConfig', expected={'SmtpClientAuthenticationDisabled': True},
                        target='Transport config (org-wide SMTP AUTH)'),
            dict(target='"Per-mailbox SMTP AUTH exceptions"', desired='Enabled only for -AllowMailbox',
                 get="@(foreach ($mailbox in @($AllowMailbox | Where-Object { $_ })) {\n    Get-CASMailbox -Identity $mailbox | Select-Object -Property Identity, PrimarySmtpAddress, SmtpClientAuthenticationDisabled\n})",
                 test='@($State | Where-Object { $null -ne $_ -and $_.SmtpClientAuthenticationDisabled -ne $false }).Count -eq 0',
                 set="foreach ($mailbox in @($State | Where-Object { $null -ne $_ -and $_.SmtpClientAuthenticationDisabled -ne $false })) {\n    Set-CASMailbox -Identity $mailbox.Identity -SmtpClientAuthenticationDisabled $false\n}")])

emit('EXO-DIRECTSEND-001',
     desc='Closes unauthenticated relay through inbound connectors that are enabled but neither require\nTLS nor restrict senders to IP addresses. Optionally also rejects Direct Send org-wide.',
     desired='No enabled inbound connector without TLS or IP restriction',
     services=[EXO],
     params=[('Action', "[Parameter(Mandatory)]\n[ValidateSet('Disable', 'RequireTls')]\n[string]",
              'Disable: turn the open connectors off. RequireTls: keep them on but require TLS.'),
             ('RejectDirectSend', "[Parameter()]\n[switch]",
              'Also set RejectDirectSend on the organization, so unauthenticated mail sent to your\naccepted domains from outside a connector is rejected.')],
     example_args='-Action RequireTls',
     notes='Scanners and apps that send through Direct Send or an open connector stop delivering.\nMove them to SMTP AUTH or a certificate- or IP-scoped connector first.',
     steps=[dict(target='Inbound connectors without TLS or IP restriction', desired='None',
                 get="@(Get-InboundConnector | Where-Object {\n    $_.Enabled -eq $true -and $_.RequireTls -eq $false -and $_.RestrictDomainsToIPAddresses -eq $false\n} | Select-Object -Property Name, Identity, Enabled, RequireTls, RestrictDomainsToIPAddresses)",
                 test='$null -eq $State -or @($State).Count -eq 0',
                 set="foreach ($connector in $State) {\n    if ($Action -eq 'Disable') {\n        Set-InboundConnector -Identity $connector.Identity -Enabled $false\n    }\n    else {\n        Set-InboundConnector -Identity $connector.Identity -RequireTls $true\n    }\n}"),
            dict(target='Organization RejectDirectSend', desired='True when -RejectDirectSend is set',
                 get='Get-OrganizationConfig | Select-Object -Property RejectDirectSend',
                 test='-not $RejectDirectSend.IsPresent -or $State.RejectDirectSend -eq $true',
                 set='Set-OrganizationConfig -RejectDirectSend $true')])

emit('EXO-DKIM-001',
     desc='Turns on DKIM signing for accepted domains. Domains without a DKIM configuration get one\ncreated (disabled) and the two CNAME records to publish are written as warnings; run the\nscript again after DNS has propagated to enable signing.',
     desired='DKIM signing enabled for each target domain',
     services=[EXO],
     params=[('DomainName', "[Parameter()]\n[string[]]", 'Domains to enable. Defaults to every authoritative accepted domain.')],
     notes='Enabling fails until the selector1/selector2 CNAMEs exist in public DNS; those domains\nreport VerifyFailed with the records to publish.',
     prelude="$targets = if (@($DomainName | Where-Object { $_ }).Count -gt 0) { @($DomainName) } else {\n    @(Get-AcceptedDomain | Where-Object { $_.DomainType -eq 'Authoritative' } | ForEach-Object { \"$($_.DomainName)\" })\n}",
     steps=[dict(target='"DKIM signing for: $($targets -join \', \')"', desired='Enabled',
                 get="@(foreach ($domain in $targets) {\n    $config = Get-DkimSigningConfig -Identity $domain -ErrorAction SilentlyContinue\n    [PSCustomObject]@{\n        Domain          = $domain\n        Exists          = $null -ne $config\n        Enabled         = [bool]$config.Enabled\n        Selector1CNAME  = $config.Selector1CNAME\n        Selector2CNAME  = $config.Selector2CNAME\n    }\n})",
                 test='@($State | Where-Object { $null -ne $_ -and -not $_.Enabled }).Count -eq 0',
                 set="foreach ($domain in @($State | Where-Object { $null -ne $_ -and -not $_.Enabled })) {\n    if (-not $domain.Exists) {\n        $created = New-DkimSigningConfig -DomainName $domain.Domain -Enabled $false\n        Write-Warning \"Publish for $($domain.Domain): selector1._domainkey CNAME $($created.Selector1CNAME); selector2._domainkey CNAME $($created.Selector2CNAME). Re-run after DNS propagates.\"\n        continue\n    }\n    try {\n        Set-DkimSigningConfig -Identity $domain.Domain -Enabled $true\n    }\n    catch {\n        Write-Warning \"Could not enable DKIM for $($domain.Domain) (publish selector1._domainkey CNAME $($domain.Selector1CNAME) and selector2._domainkey CNAME $($domain.Selector2CNAME)): $($_.Exception.Message)\"\n    }\n}")])

emit('EXO-TRANSPORT-001',
     desc='Deals with mail flow rules that set SCL -1 (bypass spam filtering) for named sender domains.',
     desired='No rule sets SCL -1 for sender domains',
     services=[EXO],
     params=[('Action', "[Parameter(Mandatory)]\n[ValidateSet('Remove', 'Disable')]\n[string]",
              'Remove: delete the rules (the check then passes). Disable: turn them off but keep them;\nthe check still lists disabled rules, so it will keep reporting them.'),
             ('RuleName', "[Parameter()]\n[string[]]", 'Limit the change to these rule names. Defaults to every matching rule.')],
     example_args='-Action Disable',
     notes='Before is returned with each rule\'s name, sender domains, and priority so the rules can be\nrecreated. Replace legitimate allow-listing with tenant allow/block list entries.',
     steps=[dict(target='Mail flow rules that bypass spam filtering by sender domain', desired='None (per -Action)',
                 get="@(Get-TransportRule | Where-Object {\n    $_.SetSCL -eq -1 -and $_.SenderDomainIs -and\n    (@($RuleName | Where-Object { $_ }).Count -eq 0 -or @($RuleName) -contains $_.Name)\n} | Select-Object -Property Name, Identity, State, Priority, SenderDomainIs, SetSCL)",
                 test="if ($Action -eq 'Disable') { @($State | Where-Object { $_.State -eq 'Enabled' }).Count -eq 0 } else { $null -eq $State -or @($State).Count -eq 0 }",
                 set="foreach ($rule in $State) {\n    if ($Action -eq 'Remove') { Remove-TransportRule -Identity $rule.Identity -Confirm:$false }\n    elseif ($rule.State -eq 'Enabled') { Disable-TransportRule -Identity $rule.Identity -Confirm:$false }\n}")])

emit('EXO-TRANSPORT-002',
     desc='Creates (or updates) a mail flow rule that rejects automatic forwarding of internal mail to\nexternal recipients. Created in Audit mode by default so you can review matches first.',
     desired='Auto-forward block rule exists with the chosen -Mode',
     services=[EXO],
     params=[("RuleName = 'Block external auto-forwarding'", "[Parameter()]\n[ValidateNotNullOrEmpty()]\n[string]", 'Name of the rule to create or update.'),
             ("Mode = 'Audit'", "[Parameter()]\n[ValidateSet('Audit', 'AuditAndNotify', 'Enforce')]\n[string]",
              'Audit (default) logs matches without blocking. Enforce blocks.'),
             ('ExceptRecipientDomain', "[Parameter()]\n[string[]]", 'External domains auto-forwarding is still allowed to.')],
     notes='Pair with EXO-FORWARD-001, which blocks forwarding in the outbound spam policy and remote\ndomain. Review message trace for rule matches before switching -Mode to Enforce.',
     prelude="$ruleSettings = @{\n    FromScope               = 'InOrganization'\n    SentToScope             = 'NotInOrganization'\n    MessageTypeMatches      = 'AutoForward'\n    RejectMessageReasonText = 'Automatic forwarding to external recipients is not allowed.'\n    Mode                    = $Mode\n}\nif (@($ExceptRecipientDomain | Where-Object { $_ }).Count -gt 0) { $ruleSettings['ExceptIfRecipientDomainIs'] = @($ExceptRecipientDomain) }",
     steps=[dict(target='"Mail flow rule $RuleName"', desired='"Rejects external auto-forwarding (Mode $Mode)"',
                 get='Get-TransportRule -Identity $RuleName -ErrorAction SilentlyContinue | Select-Object -Property Name, Identity, State, Mode, FromScope, SentToScope, MessageTypeMatches, RejectMessageReasonText, ExceptIfRecipientDomainIs',
                 test="$null -ne $State -and $State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected @{ FromScope = 'InOrganization'; SentToScope = 'NotInOrganization'; MessageTypeMatches = 'AutoForward'; Mode = $Mode })",
                 set="if ($null -eq $State) {\n    New-TransportRule -Name $RuleName @ruleSettings | Out-Null\n}\nelse {\n    Set-TransportRule -Identity $RuleName @ruleSettings\n    if ($State.State -ne 'Enabled') { Enable-TransportRule -Identity $RuleName -Confirm:$false }\n}")])
print('ok')
