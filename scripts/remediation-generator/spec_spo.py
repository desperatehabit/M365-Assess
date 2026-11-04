from gen import emit, cmdlet_props, cmdlet_step, ca_emit, ca_users

SPO = 'SharePoint'
T = dict(service=SPO, get='Get-SPOTenant', setcmd='Set-SPOTenant', target='SharePoint Online tenant settings')
EMPTY = '$null -eq $State -or @($State).Count -eq 0'

cmdlet_props('SPO-AUTH-001', **T, expected={'LegacyAuthProtocolsEnabled': False},
             desc='Blocks apps that do not use modern authentication from SharePoint and OneDrive.',
             notes='Older Office clients (2010 and earlier) and some third-party sync tools stop working.')
cmdlet_props('SPO-B2B-001', **T, expected={'EnableAzureADB2BIntegration': True},
             desc='Turns on SharePoint and OneDrive integration with Entra B2B, so external users get guest\naccounts and Conditional Access applies to them.',
             notes='Existing one-time-passcode shares keep working; new invitations create Entra guests.')
cmdlet_props('SPO-MALWARE-002', **T, expected={'DisallowInfectedFileDownload': True},
             desc='Stops users from downloading files that Defender for Office 365 has detected as malicious.')
cmdlet_props('SPO-SHARING-002', **T, expected={'PreventExternalUsersFromResharing': True},
             desc='Stops guests from re-sharing items they do not own.')
cmdlet_props('SPO-OD-001', **T, expected={'OneDriveSharingCapability': 'ExistingExternalUserSharingOnly'},
             test="@('Disabled', 'ExistingExternalUserSharingOnly') -contains \"$($State.OneDriveSharingCapability)\"",
             desc='Limits OneDrive external sharing to existing guests. A stricter existing value (Disabled) is kept.')
cmdlet_props('SPO-LOOP-002', **T, expected={'OneDriveLoopSharingCapability': 'ExistingExternalUserSharingOnly'},
             test="@('Disabled', 'ExistingExternalUserSharingOnly') -contains \"$($State.OneDriveLoopSharingCapability)\"",
             desc='Limits sharing of Loop workspaces and components stored in OneDrive to existing guests.\nA stricter existing value (Disabled) is kept.')
cmdlet_props('SPO-SCRIPT-002', **T, expected={'DenyAddAndCustomizePagesForSitesCreatedByUser': True},
             desc='Prevents users from running custom script on sites they create (self-service sites).',
             notes='Microsoft now resets custom script to blocked automatically; this sets the tenant default\nthe assessment looks for.')

emit('SPO-SHARING-005',
     desc='Makes guest access to sites and OneDrive expire automatically after 30 days or fewer.',
     desired='ExternalUserExpirationRequired = True, ExternalUserExpireInDays <= -Days',
     services=[SPO],
     params=[('Days = 30', "[Parameter()]\n[ValidateRange(1, 30)]\n[int]", 'Days after which guest access expires (1-30). An existing shorter period is kept.')],
     steps=[dict(target='SharePoint Online guest access expiration', desired='"Required, $Days days or fewer"', get='Get-SPOTenant',
                 test='$State.ExternalUserExpirationRequired -eq $true -and [int]$State.ExternalUserExpireInDays -ge 1 -and [int]$State.ExternalUserExpireInDays -le $Days',
                 set='Set-SPOTenant -ExternalUserExpirationRequired $true -ExternalUserExpireInDays $Days')])

emit('SPO-SHARING-006',
     desc='Requires people who use a verification code to re-authenticate after 30 days or fewer.',
     desired='EmailAttestationRequired = True, EmailAttestationReAuthDays <= -Days',
     services=[SPO],
     params=[('Days = 30', "[Parameter()]\n[ValidateRange(1, 30)]\n[int]", 'Re-authentication interval in days (1-30). An existing shorter interval is kept.')],
     steps=[dict(target='SharePoint Online verification code re-authentication', desired='"Required every $Days days or fewer"', get='Get-SPOTenant',
                 test='$State.EmailAttestationRequired -eq $true -and [int]$State.EmailAttestationReAuthDays -ge 1 -and [int]$State.EmailAttestationReAuthDays -le $Days',
                 set='Set-SPOTenant -EmailAttestationRequired $true -EmailAttestationReAuthDays $Days')])

emit('SPO-VERSIONING-001',
     desc='Sets the tenant default version history limit for new document libraries to at least 100\nmajor versions, with no time-based expiry, so files can be rolled back after ransomware.',
     desired='Manual version limits: MajorVersionLimit >= -MajorVersionLimit, no expiry',
     services=[SPO],
     params=[('MajorVersionLimit = 500', "[Parameter()]\n[ValidateRange(100, 50000)]\n[int]", 'Major versions to keep (100-50000). Defaults to 500, the SharePoint default.')],
     notes='Applies to new libraries. Existing libraries keep their own limits; use\nNew-SPOSiteManageVersionPolicyJob or library settings to change them.',
     steps=[dict(target='SharePoint Online default version limits', desired='"At least $MajorVersionLimit major versions, no expiry"', get='Get-SPOTenant',
                 test='$State.EnableAutoExpirationVersionTrim -eq $false -and [int]$State.MajorVersionLimit -ge $MajorVersionLimit -and [int]$State.ExpireVersionsAfterDays -eq 0',
                 set='Set-SPOTenant -EnableAutoExpirationVersionTrim $false -MajorVersionLimit $MajorVersionLimit -ExpireVersionsAfterDays 0')])

emit('SPO-SCRIPT-001',
     desc='Blocks custom script (DenyAddAndCustomizePages) on every OneDrive personal site that allows it.',
     desired='DenyAddAndCustomizePages = Enabled on all personal sites',
     services=[SPO],
     notes='Enumerates every OneDrive site, which can take a while in large tenants.',
     steps=[dict(target='OneDrive personal sites allowing custom script', desired='None',
                 get="@(Get-SPOSite -IncludePersonalSite $true -Limit All -Filter \"Url -like '-my.sharepoint.com/personal/'\" |\n    Where-Object { @('Enabled', 'True') -notcontains \"$($_.DenyAddAndCustomizePages)\" } |\n    Select-Object -Property Url, DenyAddAndCustomizePages)",
                 test=EMPTY,
                 set="foreach ($site in $State) {\n    Set-SPOSite -Identity $site.Url -DenyAddAndCustomizePages $true\n}")])

emit('SPO-SESSION-001',
     desc='Creates the organization-wide idle session timeout policy (the Microsoft 365 admin center\n"Idle session timeout" setting), signing users out of Microsoft 365 web apps after inactivity.',
     desired='An organization-default activity-based timeout policy with the chosen timeout',
     services=['Graph'], scopes=['Policy.ReadWrite.ApplicationConfiguration'],
     params=[("Timeout = '03:00:00'", "[Parameter()]\n[ValidatePattern('^\\d{2}:\\d{2}:\\d{2}$')]\n[string]", "Idle time before sign-out, as hh:mm:ss. Defaults to 3 hours (the CIS maximum).")],
     notes='Applies to Outlook on the web, SharePoint, OneDrive, and other Microsoft 365 web apps. An\nexisting policy is updated in place.',
     prelude="$definition = @{ ActivityBasedTimeoutPolicy = @{ Version = 1; ApplicationPolicies = @(@{ ApplicationId = 'default'; WebSessionIdleTimeout = $Timeout }) } } | ConvertTo-Json -Depth 5 -Compress\n$policyBody = @{\n    displayName           = 'Idle session timeout'\n    isOrganizationDefault = $true\n    definition            = @($definition)\n}",
     steps=[dict(target='Activity-based timeout policy', desired='"Idle sign-out after $Timeout"',
                 get="@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/policies/activityBasedTimeoutPolicies' -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1",
                 test="$null -ne $State -and (@($State['definition']) -join '') -match [regex]::Escape(\"\"\"WebSessionIdleTimeout\"\":\"\"$Timeout\"\"\")",
                 set="if ($null -eq $State) {\n    Invoke-MgGraphRequest -Method POST -Uri '/v1.0/policies/activityBasedTimeoutPolicies' -Body ($policyBody | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null\n}\nelse {\n    Invoke-MgGraphRequest -Method PATCH -Uri \"/v1.0/policies/activityBasedTimeoutPolicies/$($State['id'])\" -Body (@{ definition = @($definition) } | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null\n}")])

# ---- Needs decision ----------------------------------------------------
SYNC_PARAMS = [('DomainGuid', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[guid[]]",
                'GUIDs of the on-premises AD domains whose joined computers may sync\n((Get-ADDomain).ObjectGUID). Hybrid-joined devices only.'),
               ('BlockMacSync', "[Parameter()]\n[switch]", 'Also block the OneDrive sync app on Mac, which cannot be domain-restricted.')]
for cid, eff in (('SPO-SYNC-001', 'Restricts the OneDrive sync app to computers joined to the domains you list.'),
                 ('SPO-ACCESS-002', 'Restricts OneDrive / SharePoint sync to managed (domain-joined) computers.')):
    emit(cid, desc=eff, desired='Sync client restriction enabled for -DomainGuid', services=[SPO], params=SYNC_PARAMS,
         example_args="-DomainGuid '11111111-2222-3333-4444-555555555555'",
         notes='Users on personal or Entra-only-joined devices can no longer sync. For Entra-joined fleets,\nuse a Conditional Access app-enforced restriction instead.',
         steps=[dict(target='OneDrive sync client restriction', desired='Enabled for listed domains',
                     get='Get-SPOTenantSyncClientRestriction',
                     test="$allowed = @(\"$($State.AllowedDomainList)\" -split '[ ,;]' | Where-Object { $_ })\n$State.TenantRestrictionEnabled -eq $true -and @($DomainGuid | Where-Object { $allowed -notcontains \"$_\" }).Count -eq 0 -and (-not $BlockMacSync.IsPresent -or $State.BlockMacSync -eq $true)",
                     set="Set-SPOTenantSyncClientRestriction -Enable -DomainGuids (@($DomainGuid) -join ';')\nif ($BlockMacSync.IsPresent) { Set-SPOTenantSyncClientRestriction -BlockMacSync:$true }")])

emit('SPO-SYNC-002',
     desc='Turns off the OneDrive sync app on Mac.',
     desired='BlockMacSync = True', services=[SPO],
     notes='Mac users can still use OneDrive and SharePoint on the web. Only run this if Macs are not\nused, or are not allowed to hold synced copies of company data.',
     steps=[dict(target='OneDrive sync client restriction (Mac)', desired='Mac sync blocked',
                 get='Get-SPOTenantSyncClientRestriction', test='$State.BlockMacSync -eq $true',
                 set='Set-SPOTenantSyncClientRestriction -BlockMacSync:$true')])

cmdlet_props('SPO-LOOP-001', **T, expected={'IsLoopEnabled': False},
             desc='Turns off Loop components in SharePoint, OneDrive, Outlook, and Teams.',
             notes='A business decision: Loop components stop working for everyone. Existing .loop files\nremain as files.')

emit('SPO-SHARING-003',
     desc='Limits SharePoint and OneDrive external sharing to an allow-list of domains, or blocks a\nlist of domains.',
     desired='SharingDomainRestrictionMode set with the given list',
     services=[SPO],
     params=[('AllowedDomain', "[Parameter(Mandatory, ParameterSetName = 'Allow')]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'Only these external domains can be shared with. Replaces the current list.'),
             ('BlockedDomain', "[Parameter(Mandatory, ParameterSetName = 'Block')]\n[ValidateNotNullOrEmpty()]\n[string[]]", 'These external domains can never be shared with. Replaces the current list.')],
     example_args="-AllowedDomain 'partner.example'",
     prelude='$parameterSet = $PSCmdlet.ParameterSetName',
     steps=[dict(target='SharePoint Online sharing domain restriction', desired='Allow or block list configured',
                 get='Get-SPOTenant',
                 test="if ($parameterSet -eq 'Allow') {\n    \"$($State.SharingDomainRestrictionMode)\" -eq 'AllowList' -and ((@(\"$($State.SharingAllowedDomainList)\" -split ' ' | Where-Object { $_ } | Sort-Object) -join ' ') -eq (@($AllowedDomain | Sort-Object) -join ' '))\n}\nelse {\n    \"$($State.SharingDomainRestrictionMode)\" -eq 'BlockList' -and ((@(\"$($State.SharingBlockedDomainList)\" -split ' ' | Where-Object { $_ } | Sort-Object) -join ' ') -eq (@($BlockedDomain | Sort-Object) -join ' '))\n}",
                 set="if ($parameterSet -eq 'Allow') {\n    Set-SPOTenant -SharingDomainRestrictionMode AllowList -SharingAllowedDomainList (@($AllowedDomain) -join ' ')\n}\nelse {\n    Set-SPOTenant -SharingDomainRestrictionMode BlockList -SharingBlockedDomainList (@($BlockedDomain) -join ' ')\n}")])

emit('SPO-SHARING-008',
     desc='Allows only members of the security groups you list to share SharePoint and OneDrive content\nexternally.',
     desired='External sharing limited to -SecurityGroupId',
     services=[SPO],
     params=[('SecurityGroupId', "[Parameter(Mandatory)]\n[ValidateNotNullOrEmpty()]\n[guid[]]", 'Object IDs of the Entra security groups allowed to share externally.')],
     example_args="-SecurityGroupId '11111111-2222-3333-4444-555555555555'",
     notes='Uses GuestSharingGroupAllowListInTenantByPrincipalIdentity, which takes claims in the form\nc:0t.c|tenant|<group id>. Everyone outside the groups loses the ability to share externally.',
     prelude="$claims = @($SecurityGroupId | ForEach-Object { \"c:0t.c|tenant|$_\" })",
     steps=[dict(target='SharePoint Online external sharing group allow-list', desired='Limited to the given groups',
                 get='Get-SPOTenant',
                 test="$current = @($State.GuestSharingGroupAllowListInTenantByPrincipalIdentity | Where-Object { $_ })\n$current.Count -gt 0 -and @($claims | Where-Object { $current -notcontains $_ }).Count -eq 0",
                 set='Set-SPOTenant -GuestSharingGroupAllowListInTenantByPrincipalIdentity $claims')])

emit('SPO-CUIACCESS-001',
     desc='Restricts external sharing so CUI cannot leave the organization: sets the tenant sharing level\nand, optionally, turns off external sharing on the sites that hold CUI.',
     desired='Tenant sharing at -SharingLevel; CUI sites Disabled',
     services=[SPO],
     params=[('SharingLevel', "[Parameter(Mandatory)]\n[ValidateSet('ExistingExternalUserSharingOnly', 'Disabled')]\n[string]", 'Tenant-wide sharing level: existing guests only, or no external sharing.'),
             ('CuiSiteUrl', "[Parameter()]\n[string[]]", 'URLs of sites holding CUI. Their external sharing is turned off.')],
     example_args='-SharingLevel ExistingExternalUserSharingOnly',
     notes='Apply sensitivity labels and Conditional Access to the CUI sites as well; sharing settings\nalone are not a complete CUI control.',
     steps=[dict(target='SharePoint Online tenant sharing level', desired='"$SharingLevel or stricter"', get='Get-SPOTenant',
                 test="$rank = @{ Disabled = 0; ExistingExternalUserSharingOnly = 1; ExternalUserSharingOnly = 2; ExternalUserAndGuestSharing = 3 }\n$null -ne $rank[\"$($State.SharingCapability)\"] -and $rank[\"$($State.SharingCapability)\"] -le $rank[$SharingLevel]",
                 set='Set-SPOTenant -SharingCapability $SharingLevel'),
            dict(target='CUI sites', desired='External sharing disabled',
                 get="@(foreach ($url in @($CuiSiteUrl | Where-Object { $_ })) { Get-SPOSite -Identity $url | Where-Object { \"$($_.SharingCapability)\" -ne 'Disabled' } | Select-Object -Property Url, SharingCapability })",
                 test=EMPTY,
                 set="foreach ($site in $State) { Set-SPOSite -Identity $site.Url -SharingCapability Disabled }")])

RANK = "$rank = @{ Disabled = 0; ExistingExternalUserSharingOnly = 1; ExternalUserSharingOnly = 2; ExternalUserAndGuestSharing = 3 }"
emit('SPO-SITE-001',
     desc='Lowers the sharing level of any site that is more permissive than the tenant sharing level.',
     desired='No site more permissive than the tenant',
     services=[SPO],
     params=[('ExcludeSiteUrl', "[Parameter()]\n[string[]]", 'Sites to leave as they are.')],
     prelude=RANK + "\n$tenantLevel = \"$((Get-SPOTenant).SharingCapability)\"",
     steps=[dict(target='Sites above the tenant sharing level', desired='None',
                 get="@(Get-SPOSite -Limit All | Where-Object {\n    @($ExcludeSiteUrl) -notcontains $_.Url -and $null -ne $rank[\"$($_.SharingCapability)\"] -and $rank[\"$($_.SharingCapability)\"] -gt $rank[$tenantLevel]\n} | Select-Object -Property Url, Title, SharingCapability)",
                 test=EMPTY,
                 set="foreach ($site in $State) { Set-SPOSite -Identity $site.Url -SharingCapability $tenantLevel }")])

emit('SPO-SITE-002',
     desc='Restricts external sharing on sensitive sites (named with HR, Finance, Legal, Payroll, and\nsimilar keywords, or listed explicitly) to existing guests, or turns it off.',
     desired='Sensitive sites at -SharingLevel or stricter',
     services=[SPO],
     params=[('SharingLevel', "[Parameter(Mandatory)]\n[ValidateSet('ExistingExternalUserSharingOnly', 'Disabled')]\n[string]", 'Sharing level for sensitive sites.'),
             ('SiteUrl', "[Parameter()]\n[string[]]", 'Sites to treat as sensitive in addition to the keyword match.'),
             ("Keyword = @('HR', 'Human Resources', 'Finance', 'Legal', 'Payroll', 'Executive', 'Board', 'Confidential', 'Compliance')",
              "[Parameter()]\n[string[]]", 'Title keywords that mark a site as sensitive. Defaults to the assessment\'s list.'),
             ('ExcludeSiteUrl', "[Parameter()]\n[string[]]", 'Sites to leave as they are even if they match.')],
     example_args='-SharingLevel ExistingExternalUserSharingOnly',
     notes='Keyword matching is broad ("Board" also matches "Dashboard"); run with -WhatIf and review\nBefore, then use -ExcludeSiteUrl for false positives.',
     prelude=RANK,
     steps=[dict(target='Sensitive sites with external sharing', desired='"$SharingLevel or stricter"',
                 get="@(Get-SPOSite -Limit All | Where-Object {\n    $title = \"$($_.Title)\"\n    $isSensitive = @($SiteUrl) -contains $_.Url -or @($Keyword | Where-Object { $title -match [regex]::Escape($_) }).Count -gt 0\n    $isSensitive -and @($ExcludeSiteUrl) -notcontains $_.Url -and $rank[\"$($_.SharingCapability)\"] -gt $rank[$SharingLevel]\n} | Select-Object -Property Url, Title, SharingCapability)",
                 test=EMPTY,
                 set="foreach ($site in $State) { Set-SPOSite -Identity $site.Url -SharingCapability $SharingLevel }")])

ca_emit('SPO-ACCESS-001', name='M365-Assess - SharePoint require MFA and compliant device',
        desc='Creates a Conditional Access policy covering SharePoint Online (and OneDrive) that requires\nMFA, or MFA plus an Intune-compliant device.',
        params=[("Control = 'Mfa'", "[Parameter()]\n[ValidateSet('Mfa', 'MfaAndManagedDevice')]\n[string]",
                 'Mfa: require MFA. MfaAndManagedDevice: require MFA and an Intune-compliant device.')],
        extra_prelude="$grant = if ($Control -eq 'Mfa') {\n    @{ operator = 'OR'; builtInControls = @('mfa') }\n}\nelse {\n    @{ operator = 'AND'; builtInControls = @('mfa', 'compliantDevice') }\n}",
        policy="""@{
    conditions    = @{
        clientAppTypes = @('all')
        applications   = @{ includeApplications = @('00000003-0000-0ff1-ce00-000000000000') }
        """ + ca_users() + """
    }
    grantControls = $grant
}""")
print('ok')
