# Remediation script index

256 scripts: 127 for checks triaged **Scriptable** and 129 parameterized templates for **Needs decision** checks. Checks without a script are listed in [`coverage.json`](coverage.json).

All scripts are unvalidated (see [README](README.md)). Run with `-WhatIf` first.

| Collector | Check | Name | Bucket | Connects to | Required parameters |
|---|---|---|---|---|---|
| CAEvaluator | [`CA-DEVICE-001`](CAEvaluator/CA-DEVICE-001.ps1) | Ensure a managed device is required for authentication | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-DEVICE-002`](CAEvaluator/CA-DEVICE-002.ps1) | Ensure a managed device is required to register security information | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-DEVICECODE-001`](CAEvaluator/CA-DEVICECODE-001.ps1) | Ensure the device code sign-in flow is blocked | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-FALLBACK-001`](CAEvaluator/CA-FALLBACK-001.ps1) | CA policies have no valid include target (applies to nobody) | Needs decision | Microsoft Graph | `-Action` |
| CAEvaluator | [`CA-INTUNE-001`](CAEvaluator/CA-INTUNE-001.ps1) | Ensure sign-in frequency for Intune Enrollment is set to 'Every time' | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-LEGACYAUTH-001`](CAEvaluator/CA-LEGACYAUTH-001.ps1) | Enable Conditional Access policies to block legacy authentication | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-MFA-ADMIN-001`](CAEvaluator/CA-MFA-ADMIN-001.ps1) | Ensure multifactor authentication is enabled for all users in administrative roles | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-MFA-ALL-001`](CAEvaluator/CA-MFA-ALL-001.ps1) | Ensure multifactor authentication is enabled for all users | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-NAMEDLOC-001`](CAEvaluator/CA-NAMEDLOC-001.ps1) | Trusted IP-based named locations susceptible to spoofing | Needs decision | Microsoft Graph | `-NamedLocationId` |
| CAEvaluator | [`CA-NAMEDLOC-002`](CAEvaluator/CA-NAMEDLOC-002.ps1) | CA policies reference stale or deleted named locations | Needs decision | Microsoft Graph | — |
| CAEvaluator | [`CA-PHISHRES-001`](CAEvaluator/CA-PHISHRES-001.ps1) | Ensure 'Phishing-resistant MFA strength' is required for Administrators | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-REMOTEDEVICE-001`](CAEvaluator/CA-REMOTEDEVICE-001.ps1) | Ensure Remote Access Enforces Device Compliance via Conditional Access | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-REPORTONLY-001`](CAEvaluator/CA-REPORTONLY-001.ps1) | Conditional Access policies in report-only mode | Needs decision | Microsoft Graph | `-PolicyId`, `-Action` |
| CAEvaluator | [`CA-RISKPOLICY-001`](CAEvaluator/CA-RISKPOLICY-001.ps1) | CA policy combines sign-in risk and user risk (anti-pattern) | Needs decision | Microsoft Graph | `-PolicyId` |
| CAEvaluator | [`CA-ROLECOVERAGE-001`](CAEvaluator/CA-ROLECOVERAGE-001.ps1) | CA policies targeting directory roles miss active Tier-0 roles | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-SESSION-001`](CAEvaluator/CA-SESSION-001.ps1) | Persistent browser sessions allowed without device compliance | Needs decision | Microsoft Graph | `-Action` |
| CAEvaluator | [`CA-SIGNIN-FREQ-001`](CAEvaluator/CA-SIGNIN-FREQ-001.ps1) | Ensure Sign-in frequency is enabled and browser sessions are not persistent for Administrative users | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-SIGNINRISK-001`](CAEvaluator/CA-SIGNINRISK-001.ps1) | Enable Identity Protection sign-in risk policies | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-SIGNINRISK-002`](CAEvaluator/CA-SIGNINRISK-002.ps1) | Ensure 'sign-in risk' is blocked for medium and high risk | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`CA-STALEREF-001`](CAEvaluator/CA-STALEREF-001.ps1) | CA policies reference deleted or invalid groups | Needs decision | Microsoft Graph | — |
| CAEvaluator | [`CA-USERRISK-001`](CAEvaluator/CA-USERRISK-001.ps1) | Enable Identity Protection user risk policies | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`ENTRA-CA-SESSIONFREQ-001`](CAEvaluator/ENTRA-CA-SESSIONFREQ-001.ps1) | Ensure Conditional Access Enforces Session Sign-In Frequency | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| CAEvaluator | [`ENTRA-SESSIONAUTH-001`](CAEvaluator/ENTRA-SESSIONAUTH-001.ps1) | Ensure Legacy Authentication Protocols are Blocked to Protect Session Authenticity | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| Compliance | [`COMPLIANCE-ALERTPOLICY-001`](Compliance/COMPLIANCE-ALERTPOLICY-001.ps1) | Security Alert Policies Configuration | Scriptable | Security & Compliance PowerShell | — |
| Compliance | [`COMPLIANCE-AUDIT-001`](Compliance/COMPLIANCE-AUDIT-001.ps1) | Ensure Microsoft 365 audit log search is Enabled | Scriptable | Exchange Online | — |
| Compliance | [`COMPLIANCE-COMMS-001`](Compliance/COMPLIANCE-COMMS-001.ps1) | Ensure Communication Compliance Policies are Enabled | Needs decision | Security & Compliance PowerShell | `-Reviewer`, `-MonitoredGroup` |
| Compliance | [`COMPLIANCE-DLP-001`](Compliance/COMPLIANCE-DLP-001.ps1) | Ensure DLP policies are enabled | Needs decision | Security & Compliance PowerShell | `-SensitiveInformationType` |
| Compliance | [`COMPLIANCE-DLP-002`](Compliance/COMPLIANCE-DLP-002.ps1) | Ensure DLP policies are enabled for Microsoft Teams | Needs decision | Security & Compliance PowerShell | `-SensitiveInformationType` |
| Compliance | [`COMPLIANCE-DLP-003`](Compliance/COMPLIANCE-DLP-003.ps1) | Ensure DLP Policies Cover Exchange and SharePoint/OneDrive | Needs decision | Security & Compliance PowerShell | `-SensitiveInformationType` |
| Compliance | [`COMPLIANCE-LABELS-001`](Compliance/COMPLIANCE-LABELS-001.ps1) | Ensure Information Protection sensitivity label policies are published | Needs decision | Security & Compliance PowerShell | `-LabelName` |
| Compliance | [`COMPLIANCE-LABELS-002`](Compliance/COMPLIANCE-LABELS-002.ps1) | Ensure Auto-Sensitivity Labeling Policies are Configured | Needs decision | Security & Compliance PowerShell | `-LabelName`, `-SensitiveInformationType` |
| Compliance | [`PURVIEW-AUDIT-001`](Compliance/PURVIEW-AUDIT-001.ps1) | Unified Audit Logging Enabled | Scriptable | Exchange Online | — |
| Compliance | [`PURVIEW-RETENTION-001`](Compliance/PURVIEW-RETENTION-001.ps1) | Data Retention Policies | Needs decision | Security & Compliance PowerShell | `-RetentionDays` |
| DNS | [`DNS-DKIM-001`](DNS/DNS-DKIM-001.ps1) | Ensure that DKIM is enabled for all Exchange Online Domains | Needs decision | Exchange Online | — |
| Defender | [`DEFENDER-ANTIMALWARE-001`](Defender/DEFENDER-ANTIMALWARE-001.ps1) | Ensure the Common Attachment Types Filter is enabled | Scriptable | Exchange Online | — |
| Defender | [`DEFENDER-ANTIMALWARE-002`](Defender/DEFENDER-ANTIMALWARE-002.ps1) | Ensure notifications for internal users sending malware is Enabled | Scriptable | Exchange Online | `-AdminAddress` |
| Defender | [`DEFENDER-ANTIPHISH-001`](Defender/DEFENDER-ANTIPHISH-001.ps1) | Ensure that an anti-phishing policy has been created | Scriptable | Exchange Online | — |
| Defender | [`DEFENDER-ANTISPAM-001`](Defender/DEFENDER-ANTISPAM-001.ps1) | Ensure Exchange Online Spam Policies are set to notify administrators | Scriptable | Exchange Online | — |
| Defender | [`DEFENDER-ANTISPAM-002`](Defender/DEFENDER-ANTISPAM-002.ps1) | Ensure inbound anti-spam policies do not contain allowed domains | Needs decision | Exchange Online | — |
| Defender | [`DEFENDER-MALWARE-002`](Defender/DEFENDER-MALWARE-002.ps1) | Ensure comprehensive attachment filtering is applied | Scriptable | Exchange Online | — |
| Defender | [`DEFENDER-OUTBOUND-001`](Defender/DEFENDER-OUTBOUND-001.ps1) | Ensure outbound anti-spam message limits are in place | Scriptable | Exchange Online | `-NotifyAddress` |
| Defender | [`DEFENDER-PRIORITY-001`](Defender/DEFENDER-PRIORITY-001.ps1) | Ensure Priority account protection is enabled and configured | Needs decision | Exchange Online | — |
| Defender | [`DEFENDER-PRIORITY-002`](Defender/DEFENDER-PRIORITY-002.ps1) | Ensure Priority accounts have 'Strict protection' presets applied | Needs decision | Exchange Online | `-PriorityGroup` |
| Defender | [`DEFENDER-REALTIMESCAN-001`](Defender/DEFENDER-REALTIMESCAN-001.ps1) | Ensure Defender Antivirus real-time protection is enabled | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAllDevices` |
| Defender | [`DEFENDER-SAFEATTACH-001`](Defender/DEFENDER-SAFEATTACH-001.ps1) | Ensure Safe Attachments policy is enabled | Scriptable | Exchange Online | — |
| Defender | [`DEFENDER-SAFEATTACH-002`](Defender/DEFENDER-SAFEATTACH-002.ps1) | Ensure Safe Attachments for SharePoint OneDrive and Microsoft Teams is Enabled | Scriptable | Exchange Online | — |
| Defender | [`DEFENDER-SAFELINKS-001`](Defender/DEFENDER-SAFELINKS-001.ps1) | Ensure Safe Links for Office Applications is Enabled | Scriptable | Exchange Online | — |
| Defender | [`DEFENDER-ZAP-001`](Defender/DEFENDER-ZAP-001.ps1) | Ensure Zero-hour auto purge for Microsoft Teams is on | Scriptable | Exchange Online | — |
| EntApp | [`ENTRA-APPREG-002`](EntApp/ENTRA-APPREG-002.ps1) | Apps with localhost redirect URIs in production | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-APPREG-003`](EntApp/ENTRA-APPREG-003.ps1) | Apps with HTTP (non-HTTPS) redirect URIs | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-APPREG-004`](EntApp/ENTRA-APPREG-004.ps1) | Apps with wildcard redirect URIs (open redirect risk) | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-ENTAPP-001`](EntApp/ENTRA-ENTAPP-001.ps1) | Enabled apps with client credentials (secrets or certificates) | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-ENTAPP-002`](EntApp/ENTRA-ENTAPP-002.ps1) | Inactive apps with credentials (no sign-in > 90 days) | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-ENTAPP-003`](EntApp/ENTRA-ENTAPP-003.ps1) | Foreign apps with dangerous application permissions | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Permission` |
| EntApp | [`ENTRA-ENTAPP-004`](EntApp/ENTRA-ENTAPP-004.ps1) | Foreign apps with dangerous delegated permissions | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Permission` |
| EntApp | [`ENTRA-ENTAPP-005`](EntApp/ENTRA-ENTAPP-005.ps1) | Foreign apps with Entra directory roles | Needs decision | Microsoft Graph | `-ServicePrincipalId` |
| EntApp | [`ENTRA-ENTAPP-006`](EntApp/ENTRA-ENTAPP-006.ps1) | Apps with excessive permission count (>10 application permissions) | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Permission` |
| EntApp | [`ENTRA-ENTAPP-007`](EntApp/ENTRA-ENTAPP-007.ps1) | App instance property lock not enabled | Scriptable | Microsoft Graph | — |
| EntApp | [`ENTRA-ENTAPP-008`](EntApp/ENTRA-ENTAPP-008.ps1) | Managed identities with dangerous application permissions | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Permission` |
| EntApp | [`ENTRA-ENTAPP-009`](EntApp/ENTRA-ENTAPP-009.ps1) | Managed identities with Entra directory roles | Needs decision | Microsoft Graph | `-ServicePrincipalId` |
| EntApp | [`ENTRA-ENTAPP-010`](EntApp/ENTRA-ENTAPP-010.ps1) | Internal apps with Tier 0 application permissions (Global Admin escalation paths) | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Permission` |
| EntApp | [`ENTRA-ENTAPP-011`](EntApp/ENTRA-ENTAPP-011.ps1) | Foreign apps with Tier 1 data access permissions (Mail, Files, Sites) | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Permission` |
| EntApp | [`ENTRA-ENTAPP-012`](EntApp/ENTRA-ENTAPP-012.ps1) | Apps using client secrets instead of certificates | Needs decision | Microsoft Graph | `-ApplicationObjectId`, `-CertificatePath` |
| EntApp | [`ENTRA-ENTAPP-013`](EntApp/ENTRA-ENTAPP-013.ps1) | Apps with expired credentials still present | Needs decision | Microsoft Graph | — |
| EntApp | [`ENTRA-ENTAPP-014`](EntApp/ENTRA-ENTAPP-014.ps1) | Apps with both secret and certificate credentials (dual credential types) | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-ENTAPP-015`](EntApp/ENTRA-ENTAPP-015.ps1) | Service principals with client secret and permanent privileged directory role | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Action` |
| EntApp | [`ENTRA-ENTAPP-016`](EntApp/ENTRA-ENTAPP-016.ps1) | Tier 0 permission apps with owners assigned (owner can impersonate) | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-ENTAPP-017`](EntApp/ENTRA-ENTAPP-017.ps1) | Apps with directory roles that have owners assigned | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| EntApp | [`ENTRA-ENTAPP-018`](EntApp/ENTRA-ENTAPP-018.ps1) | Credentialed apps with no owners (orphaned) | Needs decision | Microsoft Graph | `-OwnerId` |
| EntApp | [`ENTRA-ENTAPP-019`](EntApp/ENTRA-ENTAPP-019.ps1) | Tier 0 apps with no sign-in activity (unused privileged permissions) | Needs decision | Microsoft Graph | `-ServicePrincipalId`, `-Permission` |
| EntApp | [`ENTRA-ENTAPP-021`](EntApp/ENTRA-ENTAPP-021.ps1) | Multi-tenant app registrations (AzureADMultipleOrgs) | Needs decision | Microsoft Graph | `-ApplicationObjectId` |
| Entra | [`ENTRA-ADMIN-001`](Entra/ENTRA-ADMIN-001.ps1) | Ensure that between two and four global admins are designated | Needs decision | Microsoft Graph | — |
| Entra | [`ENTRA-ADMIN-004`](Entra/ENTRA-ADMIN-004.ps1) | Ensure all Global Administrators use phishing-resistant MFA | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| Entra | [`ENTRA-APPREG-001`](Entra/ENTRA-APPREG-001.ps1) | Users Can Register Applications | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-APPS-001`](Entra/ENTRA-APPS-001.ps1) | Ensure third party integrated applications are not allowed | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-APPS-003`](Entra/ENTRA-APPS-003.ps1) | Ensure legacy MSOL and Azure AD PowerShell module access is blocked | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-001`](Entra/ENTRA-AUTHMETHOD-001.ps1) | Ensure weak authentication methods are disabled | Needs decision | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-002`](Entra/ENTRA-AUTHMETHOD-002.ps1) | Ensure the email OTP authentication method is disabled | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-003`](Entra/ENTRA-AUTHMETHOD-003.ps1) | Ensure Microsoft Authenticator is configured to protect against MFA fatigue | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-004`](Entra/ENTRA-AUTHMETHOD-004.ps1) | Ensure system-preferred multifactor authentication is enabled | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-005`](Entra/ENTRA-AUTHMETHOD-005.ps1) | Ensure authentication methods policy is fully migrated to the converged policy | Needs decision | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-006`](Entra/ENTRA-AUTHMETHOD-006.ps1) | Ensure suspicious activity reporting is enabled for MFA prompts | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-007`](Entra/ENTRA-AUTHMETHOD-007.ps1) | Ensure Temporary Access Pass authentication method is enabled | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-AUTHMETHOD-008`](Entra/ENTRA-AUTHMETHOD-008.ps1) | Ensure Temporary Access Pass is configured as single-use only | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-BREAKGLASS-002`](Entra/ENTRA-BREAKGLASS-002.ps1) | Ensure emergency access account activity is monitored | Needs decision | Azure Resource Manager | `-WorkspaceResourceId` |
| Entra | [`ENTRA-CA-001`](Entra/ENTRA-CA-001.ps1) | Enable Conditional Access policies to block legacy authentication | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| Entra | [`ENTRA-CLOUDADMIN-002`](Entra/ENTRA-CLOUDADMIN-002.ps1) | Ensure administrative accounts use licenses with a reduced application footprint | Needs decision | Microsoft Graph | `-SkuId` |
| Entra | [`ENTRA-CONSENT-001`](Entra/ENTRA-CONSENT-001.ps1) | Ensure user consent to apps accessing company data on their behalf is not allowed | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-CONSENT-002`](Entra/ENTRA-CONSENT-002.ps1) | Ensure the admin consent workflow is enabled | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-CONSENT-003`](Entra/ENTRA-CONSENT-003.ps1) | User consent restricted to verified publishers only | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-CONSENT-004`](Entra/ENTRA-CONSENT-004.ps1) | Tenant-wide admin consent grants to third-party apps | Needs decision | Microsoft Graph | `-ServicePrincipalId` |
| Entra | [`ENTRA-CONSENT-005`](Entra/ENTRA-CONSENT-005.ps1) | Ensure admin consent request has designated reviewers configured | Needs decision | Microsoft Graph | `-ReviewerId` |
| Entra | [`ENTRA-CONSENT-006`](Entra/ENTRA-CONSENT-006.ps1) | Ensure admin consent request sends email notifications to reviewers | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-DEVICE-001`](Entra/ENTRA-DEVICE-001.ps1) | Ensure the ability to join devices to Entra is restricted | Scriptable | Microsoft Graph | `-AllowedGroupId` |
| Entra | [`ENTRA-DEVICE-002`](Entra/ENTRA-DEVICE-002.ps1) | Ensure the maximum number of devices per user is limited | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-DEVICE-003`](Entra/ENTRA-DEVICE-003.ps1) | Ensure the GA role is not added as a local administrator during Entra join | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-DEVICE-004`](Entra/ENTRA-DEVICE-004.ps1) | Ensure local administrator assignment is limited during Entra join | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-DEVICE-005`](Entra/ENTRA-DEVICE-005.ps1) | Ensure Local Administrator Password Solution is enabled | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-DEVICE-006`](Entra/ENTRA-DEVICE-006.ps1) | Ensure users are restricted from recovering BitLocker keys | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-DISABLED-001`](Entra/ENTRA-DISABLED-001.ps1) | Disabled Member Account Count | Needs decision | Microsoft Graph | `-InactiveDays` |
| Entra | [`ENTRA-GROUP-001`](Entra/ENTRA-GROUP-001.ps1) | Ensure users cannot create security groups | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-GROUP-002`](Entra/ENTRA-GROUP-002.ps1) | Ensure a dynamic group for guest users is created | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-GROUP-003`](Entra/ENTRA-GROUP-003.ps1) | Ensure that only organizationally managed/approved public groups exist | Needs decision | Microsoft Graph | `-Action` |
| Entra | [`ENTRA-GROUP-004`](Entra/ENTRA-GROUP-004.ps1) | Dynamic groups with user-controllable membership rules in privileged contexts | Needs decision | Microsoft Graph | `-GroupId` |
| Entra | [`ENTRA-GROUP-005`](Entra/ENTRA-GROUP-005.ps1) | Sensitive groups not protected with role-assignable flag | Needs decision | Microsoft Graph | `-SourceGroupId` |
| Entra | [`ENTRA-GUEST-004`](Entra/ENTRA-GUEST-004.ps1) | Ensure that collaboration invitations are sent to allowed domains only | Needs decision | Microsoft Graph | `-AllowedDomain` |
| Entra | [`ENTRA-HYBRID-002`](Entra/ENTRA-HYBRID-002.ps1) | On-premises synced users holding Tier-0/1 Entra roles | Needs decision | Microsoft Graph | `-ConfirmReplacementAccounts` |
| Entra | [`ENTRA-MFA-001`](Entra/ENTRA-MFA-001.ps1) | Ensure all member users are 'MFA capable' | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-MFA-002`](Entra/ENTRA-MFA-002.ps1) | Percentage of users without MFA method registered | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-ORGSETTING-001`](Entra/ENTRA-ORGSETTING-001.ps1) | Ensure 'User owned apps and services' is restricted | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-ORGSETTING-002`](Entra/ENTRA-ORGSETTING-002.ps1) | Ensure internal phishing protection for Forms is enabled | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-ORGSETTING-004`](Entra/ENTRA-ORGSETTING-004.ps1) | Ensure shared bookings pages are restricted to select users | Scriptable | Exchange Online | — |
| Entra | [`ENTRA-PASSWORD-001`](Entra/ENTRA-PASSWORD-001.ps1) | Ensure the 'Password expiration policy' is set to 'Set passwords to never expire' | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-PASSWORD-002`](Entra/ENTRA-PASSWORD-002.ps1) | Ensure custom banned passwords lists are used | Needs decision | Microsoft Graph | `-BannedTerm` |
| Entra | [`ENTRA-PASSWORD-003`](Entra/ENTRA-PASSWORD-003.ps1) | Smart Lockout Threshold | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-PASSWORD-004`](Entra/ENTRA-PASSWORD-004.ps1) | Custom Banned Password Count | Needs decision | Microsoft Graph | `-BannedTerm` |
| Entra | [`ENTRA-PERUSER-001`](Entra/ENTRA-PERUSER-001.ps1) | Ensure 'Per-user MFA' is disabled | Needs decision | Microsoft Graph | `-ConfirmCaEnforcesMfa` |
| Entra | [`ENTRA-PIM-001`](Entra/ENTRA-PIM-001.ps1) | Ensure 'Privileged Identity Management' is used to manage roles | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| Entra | [`ENTRA-PIM-002`](Entra/ENTRA-PIM-002.ps1) | Ensure 'Access reviews' for Guest Users are configured | Needs decision | Microsoft Graph | `-FallbackReviewerId` |
| Entra | [`ENTRA-PIM-003`](Entra/ENTRA-PIM-003.ps1) | Ensure 'Access reviews' for privileged roles are configured | Needs decision | Microsoft Graph | `-ReviewerId` |
| Entra | [`ENTRA-PIM-004`](Entra/ENTRA-PIM-004.ps1) | Ensure approval is required for Global Administrator role activation | Needs decision | Microsoft Graph | `-ApproverGroupId` |
| Entra | [`ENTRA-PIM-005`](Entra/ENTRA-PIM-005.ps1) | Ensure approval is required for Privileged Role Administrator activation | Needs decision | Microsoft Graph | `-ApproverGroupId` |
| Entra | [`ENTRA-PIM-006`](Entra/ENTRA-PIM-006.ps1) | Tier-0 role activation duration exceeds 4 hours | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-PIM-007`](Entra/ENTRA-PIM-007.ps1) | Justification not required on Tier-0 role activation | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-PIM-008`](Entra/ENTRA-PIM-008.ps1) | MFA not required on Tier-0 role activation | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-PIM-009`](Entra/ENTRA-PIM-009.ps1) | Permanent eligible assignments allowed for Tier-0 roles | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-PIM-010`](Entra/ENTRA-PIM-010.ps1) | No admin notification on Tier-0 role activation | Scriptable | Microsoft Graph | `-NotifyAddress` |
| Entra | [`ENTRA-PRIVREMOTE-001`](Entra/ENTRA-PRIVREMOTE-001.ps1) | Ensure privileged commands require PIM activation for remote access | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| Entra | [`ENTRA-SESSION-001`](Entra/ENTRA-SESSION-001.ps1) | Ensure the option to remain signed in is hidden | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-SSPR-001`](Entra/ENTRA-SSPR-001.ps1) | Ensure MFA Registration Campaign is enabled to nudge users toward stronger methods | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-SSPR-002`](Entra/ENTRA-SSPR-002.ps1) | SSPR enabled for admin accounts | Needs decision | Microsoft Graph | — |
| Entra | [`ENTRA-TENANT-001`](Entra/ENTRA-TENANT-001.ps1) | Ensure 'Restrict non-admin users from creating tenants' is set to 'Yes' | Scriptable | Microsoft Graph | — |
| Entra | [`ENTRA-TOU-001`](Entra/ENTRA-TOU-001.ps1) | Ensure Terms of Use agreement policy is configured | Needs decision | Microsoft Graph | `-PdfPath` |
| ExchangeOnline | [`EXO-ADDINS-001`](ExchangeOnline/EXO-ADDINS-001.ps1) | Ensure users installing Outlook add-ins is not allowed | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-ANTIPHISH-001`](ExchangeOnline/EXO-ANTIPHISH-001.ps1) | Anti-Phishing Policy Configuration | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-ANTISPAM-001`](ExchangeOnline/EXO-ANTISPAM-001.ps1) | Anti-Spam Policy Configuration | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-AUDIT-001`](ExchangeOnline/EXO-AUDIT-001.ps1) | Ensure 'AuditDisabled' organizationally is set to 'False' | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-AUDIT-002`](ExchangeOnline/EXO-AUDIT-002.ps1) | Ensure 'AuditBypassEnabled' is not enabled on mailboxes | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-AUDIT-003`](ExchangeOnline/EXO-AUDIT-003.ps1) | Ensure mailbox audit actions are configured | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-AUTH-001`](ExchangeOnline/EXO-AUTH-001.ps1) | Ensure modern authentication for Exchange Online is enabled | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-AUTH-002`](ExchangeOnline/EXO-AUTH-002.ps1) | Ensure SMTP AUTH is disabled | Needs decision | Exchange Online | — |
| ExchangeOnline | [`EXO-CONNFILTER-001`](ExchangeOnline/EXO-CONNFILTER-001.ps1) | Ensure the connection filter IP allow list is not used | Needs decision | Exchange Online | — |
| ExchangeOnline | [`EXO-CONNFILTER-002`](ExchangeOnline/EXO-CONNFILTER-002.ps1) | Ensure the connection filter safe list is off | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-DIRECTSEND-001`](ExchangeOnline/EXO-DIRECTSEND-001.ps1) | Ensure Direct Send is not allowed for unauthorized relay | Needs decision | Exchange Online | `-Action` |
| ExchangeOnline | [`EXO-DKIM-001`](ExchangeOnline/EXO-DKIM-001.ps1) | DKIM Signing Configuration | Needs decision | Exchange Online | — |
| ExchangeOnline | [`EXO-EXTTAG-001`](ExchangeOnline/EXO-EXTTAG-001.ps1) | Ensure email from external senders is identified | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-FORWARD-001`](ExchangeOnline/EXO-FORWARD-001.ps1) | Ensure all forms of mail forwarding are blocked and/or disabled | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-LOCKBOX-001`](ExchangeOnline/EXO-LOCKBOX-001.ps1) | Ensure the customer lockbox feature is enabled | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-MAILTIPS-001`](ExchangeOnline/EXO-MAILTIPS-001.ps1) | Ensure MailTips are enabled for end users | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-MALWARE-001`](ExchangeOnline/EXO-MALWARE-001.ps1) | Malware Filter Policy Configuration | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-OWA-001`](ExchangeOnline/EXO-OWA-001.ps1) | Ensure additional storage providers are restricted in Outlook on the web | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-SHAREDMBX-001`](ExchangeOnline/EXO-SHAREDMBX-001.ps1) | Ensure sign-in to shared mailboxes is blocked | Scriptable | Exchange Online, Microsoft Graph | — |
| ExchangeOnline | [`EXO-SHARING-001`](ExchangeOnline/EXO-SHARING-001.ps1) | Ensure 'External sharing' of calendars is not available | Scriptable | Exchange Online | — |
| ExchangeOnline | [`EXO-TRANSPORT-001`](ExchangeOnline/EXO-TRANSPORT-001.ps1) | Ensure mail transport rules do not whitelist specific domains | Needs decision | Exchange Online | `-Action` |
| ExchangeOnline | [`EXO-TRANSPORT-002`](ExchangeOnline/EXO-TRANSPORT-002.ps1) | Transport Rule Configuration for External Forwarding | Needs decision | Exchange Online | — |
| Forms | [`FORMS-CONFIG-001`](Forms/FORMS-CONFIG-001.ps1) | Ensure external users cannot respond to Microsoft Forms | Scriptable | Microsoft Graph | — |
| Forms | [`FORMS-CONFIG-002`](Forms/FORMS-CONFIG-002.ps1) | Ensure external users cannot collaborate on Microsoft Forms | Scriptable | Microsoft Graph | — |
| Forms | [`FORMS-CONFIG-003`](Forms/FORMS-CONFIG-003.ps1) | Ensure external users cannot view form results | Scriptable | Microsoft Graph | — |
| Forms | [`FORMS-CONFIG-004`](Forms/FORMS-CONFIG-004.ps1) | Ensure Microsoft Forms phishing protection is enabled | Scriptable | Microsoft Graph | — |
| Forms | [`FORMS-CONFIG-005`](Forms/FORMS-CONFIG-005.ps1) | Ensure respondent identity recording is enabled by default | Scriptable | Microsoft Graph | — |
| Forms | [`FORMS-CONFIG-006`](Forms/FORMS-CONFIG-006.ps1) | Ensure Bing image and video search is disabled in Forms | Scriptable | Microsoft Graph | — |
| Intune | [`INTUNE-APPCONTROL-001`](Intune/INTUNE-APPCONTROL-001.ps1) | Ensure application control policies restrict unauthorized software | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-AUTODISC-001`](Intune/INTUNE-AUTODISC-001.ps1) | Ensure automated device discovery and enrollment is configured | Scriptable | Microsoft Graph | — |
| Intune | [`INTUNE-COMPLIANCE-001`](Intune/INTUNE-COMPLIANCE-001.ps1) | Ensure devices without a compliance policy are marked 'not compliant' | Scriptable | Microsoft Graph | — |
| Intune | [`INTUNE-ENCRYPTION-001`](Intune/INTUNE-ENCRYPTION-001.ps1) | Device Encryption Policy | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-ENROLL-001`](Intune/INTUNE-ENROLL-001.ps1) | Ensure device enrollment for personally owned devices is blocked by default | Needs decision | Microsoft Graph | — |
| Intune | [`INTUNE-ENROLLMENT-001`](Intune/INTUNE-ENROLLMENT-001.ps1) | Device Enrollment Restrictions | Needs decision | Microsoft Graph | — |
| Intune | [`INTUNE-FIPS-001`](Intune/INTUNE-FIPS-001.ps1) | Ensure FIPS-validated cryptography is enforced on managed devices | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-INVENTORY-001`](Intune/INTUNE-INVENTORY-001.ps1) | Ensure Intune serves as authoritative device inventory with categories | Needs decision | Microsoft Graph | `-CategoryName` |
| Intune | [`INTUNE-MOBILECODE-001`](Intune/INTUNE-MOBILECODE-001.ps1) | Ensure PowerShell Execution Policy Restricts Script Execution on Managed Devices | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-MOBILEENCRYPT-001`](Intune/INTUNE-MOBILEENCRYPT-001.ps1) | Ensure mobile device compliance policies require encryption | Needs decision | Microsoft Graph | — |
| Intune | [`INTUNE-PORTSTORAGE-001`](Intune/INTUNE-PORTSTORAGE-001.ps1) | Ensure portable storage devices are restricted on external systems | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-REMOTEVPN-001`](Intune/INTUNE-REMOTEVPN-001.ps1) | Ensure Always-On VPN Is Configured for Managed Remote Devices | Needs decision | Microsoft Graph | `-ServerAddress`, `-ConnectionType`, `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-REMOVABLEMEDIA-001`](Intune/INTUNE-REMOVABLEMEDIA-001.ps1) | Ensure Removable Media Use is Blocked on Managed Devices | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-SECURITY-001`](Intune/INTUNE-SECURITY-001.ps1) | Device Compliance Policy Baseline | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-UPDATE-001`](Intune/INTUNE-UPDATE-001.ps1) | Windows Update Ring Configuration | Needs decision | Microsoft Graph | `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-VPNCONFIG-001`](Intune/INTUNE-VPNCONFIG-001.ps1) | Ensure VPN Split Tunneling is Prevented on Managed Devices | Needs decision | Microsoft Graph | `-ServerAddress`, `-ConnectionType`, `-AssignToGroupId`, `-AssignToAll` |
| Intune | [`INTUNE-WIFI-001`](Intune/INTUNE-WIFI-001.ps1) | Ensure WiFi Enterprise Authentication and Encryption on Managed Devices | Needs decision | Microsoft Graph | `-Ssid`, `-RadiusServerName`, `-RootCertificateProfileId`, `-ClientCertificateProfileId`, `-AssignToGroupId`, `-AssignToAll` |
| PowerBI | [`PBI-API-001`](PowerBI/PBI-API-001.ps1) | Ensure access to APIs by Service Principals is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-AUTH-001`](PowerBI/PBI-AUTH-001.ps1) | Ensure 'Block ResourceKey Authentication' is 'Enabled' in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-CONTENT-001`](PowerBI/PBI-CONTENT-001.ps1) | Ensure guest access to content is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-GUEST-001`](PowerBI/PBI-GUEST-001.ps1) | Ensure guest user access is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-INVITE-001`](PowerBI/PBI-INVITE-001.ps1) | Ensure external user invitations are restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-LABELS-001`](PowerBI/PBI-LABELS-001.ps1) | Ensure 'Allow users to apply sensitivity labels for content' is 'Enabled' in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-LINK-001`](PowerBI/PBI-LINK-001.ps1) | Ensure shareable links are restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-PROFILE-001`](PowerBI/PBI-PROFILE-001.ps1) | Ensure Service Principals cannot create and use profiles in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-PUBLISH-001`](PowerBI/PBI-PUBLISH-001.ps1) | Ensure 'Publish to web' is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-SCRIPT-001`](PowerBI/PBI-SCRIPT-001.ps1) | Ensure 'Interact with and share R and Python' visuals is 'Disabled' in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-SHARING-001`](PowerBI/PBI-SHARING-001.ps1) | Ensure enabling of external data sharing is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`PBI-TENANT-001`](PowerBI/PBI-TENANT-001.ps1) | Power BI External Sharing Configuration | Scriptable | Power BI | — |
| PowerBI | [`PBI-TENANT-002`](PowerBI/PBI-TENANT-002.ps1) | Power BI Publish to Web Configuration | Scriptable | Power BI | — |
| PowerBI | [`PBI-TENANT-003`](PowerBI/PBI-TENANT-003.ps1) | Power BI Guest Access Configuration | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-AUTH-001`](PowerBI/POWERBI-AUTH-001.ps1) | Ensure 'Block ResourceKey Authentication' is 'Enabled' in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-AUTH-002`](PowerBI/POWERBI-AUTH-002.ps1) | Ensure access to APIs by Service Principals is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-AUTH-003`](PowerBI/POWERBI-AUTH-003.ps1) | Ensure Service Principals cannot create and use profiles in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-GUEST-001`](PowerBI/POWERBI-GUEST-001.ps1) | Ensure guest user access is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-GUEST-002`](PowerBI/POWERBI-GUEST-002.ps1) | Ensure external user invitations are restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-GUEST-003`](PowerBI/POWERBI-GUEST-003.ps1) | Ensure guest access to content is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-INFOPROT-001`](PowerBI/POWERBI-INFOPROT-001.ps1) | Ensure 'Allow users to apply sensitivity labels for content' is 'Enabled' in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-SERVICEPRINCIPAL-001`](PowerBI/POWERBI-SERVICEPRINCIPAL-001.ps1) | Ensure service principals are restricted from creating Power BI workspaces, connections and deployment pipelines | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-SHARING-001`](PowerBI/POWERBI-SHARING-001.ps1) | Ensure 'Publish to web' is restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-SHARING-002`](PowerBI/POWERBI-SHARING-002.ps1) | Ensure 'Interact with and share R and Python' visuals is 'Disabled' in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-SHARING-003`](PowerBI/POWERBI-SHARING-003.ps1) | Ensure shareable links are restricted in Power BI | Scriptable | Power BI | — |
| PowerBI | [`POWERBI-SHARING-004`](PowerBI/POWERBI-SHARING-004.ps1) | Ensure enabling of external data sharing is restricted in Power BI | Scriptable | Power BI | — |
| PurviewRetention | [`PURVIEW-RETENTION-002`](PurviewRetention/PURVIEW-RETENTION-002.ps1) | Ensure Exchange is covered by a retention policy | Needs decision | Security & Compliance PowerShell | `-RetentionDays` |
| PurviewRetention | [`PURVIEW-RETENTION-003`](PurviewRetention/PURVIEW-RETENTION-003.ps1) | Ensure Teams is covered by a retention policy | Needs decision | Security & Compliance PowerShell | `-RetentionDays` |
| PurviewRetention | [`PURVIEW-RETENTION-004`](PurviewRetention/PURVIEW-RETENTION-004.ps1) | Ensure SharePoint/OneDrive is covered by a retention policy | Needs decision | Security & Compliance PowerShell | `-RetentionDays` |
| PurviewRetention | [`PURVIEW-RETENTION-005`](PurviewRetention/PURVIEW-RETENTION-005.ps1) | Ensure all retention policies are in Enforce mode | Needs decision | Security & Compliance PowerShell | — |
| SharePoint | [`SPO-ACCESS-001`](SharePoint/SPO-ACCESS-001.ps1) | Conditional Access policy coverage for SharePoint | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| SharePoint | [`SPO-ACCESS-002`](SharePoint/SPO-ACCESS-002.ps1) | Unmanaged device sync restriction | Needs decision | SharePoint Online | `-DomainGuid` |
| SharePoint | [`SPO-AUTH-001`](SharePoint/SPO-AUTH-001.ps1) | Ensure modern authentication for SharePoint applications is required | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-B2B-001`](SharePoint/SPO-B2B-001.ps1) | Ensure SharePoint and OneDrive integration with Azure AD B2B is enabled | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-CUIACCESS-001`](SharePoint/SPO-CUIACCESS-001.ps1) | Ensure SharePoint External Sharing Restricts Access to CUI on Digital Media | Needs decision | SharePoint Online | `-SharingLevel` |
| SharePoint | [`SPO-LOOP-001`](SharePoint/SPO-LOOP-001.ps1) | Loop Components Enabled | Needs decision | SharePoint Online | — |
| SharePoint | [`SPO-LOOP-002`](SharePoint/SPO-LOOP-002.ps1) | OneDrive Loop Sharing | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-MALWARE-002`](SharePoint/SPO-MALWARE-002.ps1) | Ensure Office 365 SharePoint infected files are disallowed for download | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-OD-001`](SharePoint/SPO-OD-001.ps1) | Ensure OneDrive content sharing is restricted | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-SCRIPT-001`](SharePoint/SPO-SCRIPT-001.ps1) | Ensure custom script execution is restricted on personal sites | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-SCRIPT-002`](SharePoint/SPO-SCRIPT-002.ps1) | Ensure custom script execution is restricted on site collections | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-SESSION-001`](SharePoint/SPO-SESSION-001.ps1) | Ensure 'Idle session timeout' is set to '3 hours (or less)' for unmanaged devices | Scriptable | Microsoft Graph | — |
| SharePoint | [`SPO-SHARING-002`](SharePoint/SPO-SHARING-002.ps1) | Ensure that SharePoint guest users cannot share items they don't own | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-SHARING-003`](SharePoint/SPO-SHARING-003.ps1) | Ensure SharePoint external sharing is managed through domain whitelist/blacklists | Needs decision | SharePoint Online | `-AllowedDomain`, `-BlockedDomain` |
| SharePoint | [`SPO-SHARING-005`](SharePoint/SPO-SHARING-005.ps1) | Ensure guest access to a site or OneDrive will expire automatically | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-SHARING-006`](SharePoint/SPO-SHARING-006.ps1) | Ensure reauthentication with verification code is restricted | Scriptable | SharePoint Online | — |
| SharePoint | [`SPO-SHARING-008`](SharePoint/SPO-SHARING-008.ps1) | Ensure external sharing is restricted by security group | Needs decision | SharePoint Online | `-SecurityGroupId` |
| SharePoint | [`SPO-SITE-001`](SharePoint/SPO-SITE-001.ps1) | Site sharing level within tenant policy | Needs decision | SharePoint Online | — |
| SharePoint | [`SPO-SITE-002`](SharePoint/SPO-SITE-002.ps1) | Sensitive sites have restricted external sharing | Needs decision | SharePoint Online | `-SharingLevel` |
| SharePoint | [`SPO-SYNC-001`](SharePoint/SPO-SYNC-001.ps1) | Ensure OneDrive sync is restricted for unmanaged devices | Needs decision | SharePoint Online | `-DomainGuid` |
| SharePoint | [`SPO-SYNC-002`](SharePoint/SPO-SYNC-002.ps1) | Mac Sync App Enabled | Needs decision | SharePoint Online | — |
| SharePoint | [`SPO-VERSIONING-001`](SharePoint/SPO-VERSIONING-001.ps1) | Version history configuration | Scriptable | SharePoint Online | — |
| StrykerReadiness | [`CA-EXCLUSION-001`](StrykerReadiness/CA-EXCLUSION-001.ps1) | Privileged admins excluded from Conditional Access policies | Needs decision | Microsoft Graph | `-BreakGlassAccountId` |
| StrykerReadiness | [`ENTRA-APPS-002`](StrykerReadiness/ENTRA-APPS-002.ps1) | App registrations with dangerous Intune write permissions | Needs decision | Microsoft Graph | `-ServicePrincipalId` |
| StrykerReadiness | [`ENTRA-ROLEGROUP-001`](StrykerReadiness/ENTRA-ROLEGROUP-001.ps1) | Unprotected groups in privileged role assignments | Needs decision | Microsoft Graph | `-GroupId` |
| StrykerReadiness | [`ENTRA-STALEADMIN-001`](StrykerReadiness/ENTRA-STALEADMIN-001.ps1) | Admin accounts inactive for more than 90 days | Needs decision | Microsoft Graph | `-BreakGlassAccountId`, `-Action` |
| StrykerReadiness | [`ENTRA-SYNCADMIN-001`](StrykerReadiness/ENTRA-SYNCADMIN-001.ps1) | On-premises synced admin accounts (compromise path) | Needs decision | Microsoft Graph | `-ConfirmReplacementAccounts` |
| StrykerReadiness | [`INTUNE-MAA-001`](StrykerReadiness/INTUNE-MAA-001.ps1) | Multi-Admin Approval not enabled for destructive operations | Needs decision | Microsoft Graph | `-ApproverGroupId` |
| StrykerReadiness | [`INTUNE-RBAC-001`](StrykerReadiness/INTUNE-RBAC-001.ps1) | RBAC role assignments without scope tags | Needs decision | Microsoft Graph | `-RoleAssignmentId`, `-ScopeGroupId` |
| Teams | [`TEAMS-APPS-001`](Teams/TEAMS-APPS-001.ps1) | Chat Resource-Specific Consent Enabled | Scriptable | Microsoft Graph | — |
| Teams | [`TEAMS-APPS-002`](Teams/TEAMS-APPS-002.ps1) | Ensure app permission policies are configured | Needs decision | Microsoft Teams | — |
| Teams | [`TEAMS-CLIENT-001`](Teams/TEAMS-CLIENT-001.ps1) | Ensure external file sharing in Teams is enabled for only approved cloud storage services | Needs decision | Microsoft Teams | — |
| Teams | [`TEAMS-CLIENT-002`](Teams/TEAMS-CLIENT-002.ps1) | Ensure users can't send emails to a channel email address | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-EXTACCESS-001`](Teams/TEAMS-EXTACCESS-001.ps1) | Ensure communication with unmanaged Teams users is disabled | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-EXTACCESS-002`](Teams/TEAMS-EXTACCESS-002.ps1) | Ensure external Teams users cannot initiate conversations | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-EXTACCESS-003`](Teams/TEAMS-EXTACCESS-003.ps1) | Ensure external domains are restricted in the Teams admin center | Needs decision | Microsoft Teams | `-AllowedDomain`, `-DisableFederation` |
| Teams | [`TEAMS-EXTACCESS-004`](Teams/TEAMS-EXTACCESS-004.ps1) | Ensure communication with Skype users is disabled | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-GUEST-001`](Teams/TEAMS-GUEST-001.ps1) | Guest Access to Teams | Needs decision | Microsoft Teams | `-Mode` |
| Teams | [`TEAMS-MEETING-001`](Teams/TEAMS-MEETING-001.ps1) | Ensure anonymous users can't join a meeting | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-002`](Teams/TEAMS-MEETING-002.ps1) | Ensure anonymous users and dial-in callers can't start a meeting | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-003`](Teams/TEAMS-MEETING-003.ps1) | Ensure only people in my org can bypass the lobby | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-004`](Teams/TEAMS-MEETING-004.ps1) | Ensure users dialing in can't bypass the lobby | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-005`](Teams/TEAMS-MEETING-005.ps1) | Ensure external participants can't give or request control | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-006`](Teams/TEAMS-MEETING-006.ps1) | Ensure meeting chat does not allow anonymous users | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-007`](Teams/TEAMS-MEETING-007.ps1) | Ensure only organizers and co-organizers can present | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-008`](Teams/TEAMS-MEETING-008.ps1) | Ensure external meeting chat is off | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-MEETING-009`](Teams/TEAMS-MEETING-009.ps1) | Ensure meeting recording is off by default | Scriptable | Microsoft Teams | — |
| Teams | [`TEAMS-REPORTING-001`](Teams/TEAMS-REPORTING-001.ps1) | Ensure users can report security concerns in Teams | Scriptable | Microsoft Teams | — |
