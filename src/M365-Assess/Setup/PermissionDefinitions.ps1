# Permission definitions for Grant-M365AssessConsent
# These data tables define the exact permissions required by Invoke-M365Assessment.

# ==============================================================================
# GRAPH API PERMISSIONS
# Source: $sectionScopeMap from all sections, deduplicated
# ==============================================================================

$script:RequiredGraphPermissions = @(
    # -- Tenant ----------------------------------------------------------------
    @{ Name = 'Organization.Read.All';                   Sections = 'Tenant, Identity, Licensing, Hybrid, Security'; Reason = 'Tenant org details, verified domains, hybrid config, company branding, subscribed SKUs' }
    @{ Name = 'Domain.Read.All';                         Sections = 'Tenant, Identity, Hybrid'               ; Reason = 'All domains registered in the tenant' }
    @{ Name = 'Group.Read.All';                          Sections = 'Tenant, Inventory'                      ; Reason = 'All groups including Microsoft 365 and security groups' }
    # -- Identity --------------------------------------------------------------
    @{ Name = 'User.Read.All';                           Sections = 'Tenant, Identity, Licensing, Inventory, SOC2' ; Reason = 'User profiles, sign-in activity, license assignments' }
    @{ Name = 'AuditLog.Read.All';                       Sections = 'Identity, SOC2'                         ; Reason = 'Sign-in logs and directory audit events' }
    @{ Name = 'UserAuthenticationMethod.Read.All';       Sections = 'Identity'                               ; Reason = 'MFA and passwordless authentication methods per user' }
    @{ Name = 'RoleManagement.Read.Directory';           Sections = 'Identity, SOC2'                         ; Reason = 'Entra directory role assignments and PIM eligibility' }
    @{ Name = 'Policy.Read.All';                         Sections = 'Tenant, Identity, SOC2'                 ; Reason = 'Conditional Access, auth methods, token lifetime, password policies' }
    @{ Name = 'Application.Read.All';                    Sections = 'Identity'                               ; Reason = 'App registrations, service principals, OAuth permission grants' }
    @{ Name = 'Agreement.Read.All';                      Sections = 'Identity'                               ; Reason = 'Terms of Use agreements and their acceptance settings (ENTRA-TOU-001)' }
    @{ Name = 'Directory.Read.All';                      Sections = 'Identity, SOC2'                         ; Reason = 'Devices, admin units, role templates' }
    # -- Intune ----------------------------------------------------------------
    @{ Name = 'DeviceManagementManagedDevices.Read.All'; Sections = 'Intune'                                 ; Reason = 'Managed device inventory and compliance state' }
    @{ Name = 'DeviceManagementConfiguration.Read.All';  Sections = 'Intune, Security'                       ; Reason = 'Configuration profiles, compliance policies, Multi-Admin Approval policies' }
    @{ Name = 'DeviceManagementRBAC.Read.All';           Sections = 'Security'                               ; Reason = 'Intune RBAC role definitions and assignments (scope tag audit)' }
    @{ Name = 'DeviceManagementApps.Read.All';           Sections = 'Security'                               ; Reason = 'Intune audit events including device wipe/retire/delete actions' }
    # -- Portal feature workers (EPIC-017/018) ---------------------------------
    @{ Name = 'DeviceManagementServiceConfig.Read.All';  Sections = 'Intune'                                 ; Reason = 'Autopilot deployment profiles and Apple/Android enrollment profiles' }
    @{ Name = 'BitlockerKey.Read.All';                   Sections = 'Intune, Security'                       ; Reason = 'BitLocker recovery key retrieval for portal device actions' }
    # -- Security --------------------------------------------------------------
    @{ Name = 'SecurityEvents.Read.All';                 Sections = 'Security, SOC2'                         ; Reason = 'Secure Score, improvement actions, security alerts' }
    @{ Name = 'SecurityAlert.Read.All';                  Sections = 'SOC2'                                   ; Reason = 'Defender security alerts (alerts_v2) for SOC 2 alert triage evidence' }
    @{ Name = 'IdentityRiskEvent.Read.All';              Sections = 'SOC2'                                   ; Reason = 'Entra ID Protection risk detections for SOC 2 audit evidence' }
    @{ Name = 'CustomDetection.Read.All';                Sections = 'Security'                               ; Reason = 'Defender XDR custom detection rules (emergency access account monitoring)' }
    # -- Collaboration ---------------------------------------------------------
    @{ Name = 'SharePointTenantSettings.Read.All';       Sections = 'Collaboration'                          ; Reason = 'SharePoint and OneDrive tenant-level settings' }
    @{ Name = 'TeamSettings.Read.All';                   Sections = 'Collaboration'                          ; Reason = 'Teams tenant-level settings and policies' }
    @{ Name = 'TeamworkAppSettings.Read.All';            Sections = 'Collaboration'                          ; Reason = 'Teams app permission and setup policies' }
    @{ Name = 'OrgSettings-Forms.Read.All';             Sections = 'Collaboration'                          ; Reason = 'Microsoft Forms tenant-level settings' }
    @{ Name = 'MailboxSettings.Read';                   Sections = 'Email'                                  ; Reason = 'Mailbox-level settings (forwarding, audit, locale) via Graph' }
    # -- Inventory -------------------------------------------------------------
    @{ Name = 'Team.ReadBasic.All';                      Sections = 'Inventory'                              ; Reason = 'Enumerate all Teams' }
    @{ Name = 'TeamMember.Read.All';                     Sections = 'Inventory'                              ; Reason = 'Teams membership details' }
    @{ Name = 'Channel.ReadBasic.All';                   Sections = 'Inventory'                              ; Reason = 'Teams channels' }
    @{ Name = 'Reports.Read.All';                        Sections = 'Inventory, SOC2'                        ; Reason = 'Microsoft 365 usage reports' }
    @{ Name = 'Sites.Read.All';                          Sections = 'Inventory'                              ; Reason = 'SharePoint site enumeration and metadata' }
)

# ==============================================================================
# EXCHANGE ONLINE ROLE GROUPS
#
# Cloud-only EXO tenants do NOT have "View-Only Recipients" or
# "View-Only Configuration" -- those only exist in on-premises / hybrid Exchange.
# In Exchange Online, "View-Only Organization Management" covers the equivalent
# read-only access for mailboxes, recipients, transport rules, and connectors.
#
# "Security Reader" is intentionally excluded here -- it is ambiguous (exists in
# both EXO and Entra ID) and causes a "matches multiple entries" error. The
# Entra ID "Security Reader" directory role is assigned in the Compliance step
# below, which is the correct surface for Defender/security policy reads.
# ==============================================================================

$script:RequiredExoRoleGroups = @(
    @{
        RoleGroup = 'View-Only Organization Management'
        Sections  = 'Email, Security, Inventory'
        Reason    = 'Read-only access to mailboxes, recipients, transport rules, connectors, and EOP/Defender policies. Replaces the on-prem-only "View-Only Recipients" and "View-Only Configuration" groups in cloud EXO.'
    }
    @{
        RoleGroup = 'Compliance Management'
        Sections  = 'Security'
        Reason    = 'Read access to compliance-related EXO configuration (journal rules, message tracking, transport compliance rules).'
    }
)

# ==============================================================================
# PURVIEW / COMPLIANCE ENTRA DIRECTORY ROLES
#
# These are Entra ID built-in directory roles, NOT Security & Compliance
# PowerShell role groups. They must be assigned via Graph
# (New-MgDirectoryRoleMemberByRef), not Connect-IPPSSession.
#
# Role template GUIDs are stable across all tenants (built-in roles).
# ==============================================================================

$script:RequiredComplianceRoles = @(
    @{
        DisplayName  = 'Compliance Administrator'
        TemplateId   = '17315797-102d-40b4-93e0-432062caca18'
        Sections     = 'Security'
        Reason       = 'Read access to Purview compliance configuration -- DLP policies, audit, retention, sensitivity labels.'
    }
    @{
        DisplayName  = 'Security Reader'
        TemplateId   = '5d6b6bb7-de71-4623-b4af-96380a352509'
        Sections     = 'Security'
        Reason       = 'Read access to Microsoft Defender and security-related settings, alerts, and policies.'
    }
    @{
        DisplayName  = 'Global Reader'
        TemplateId   = 'f2ef992c-3afb-46b9-b7cf-a126ee74c451'
        Sections     = 'Security, Compliance'
        Reason       = 'Broad read-only access across Microsoft 365 services including Purview, covering gaps not addressed by the above roles.'
    }
)

# ==============================================================================
# OPERATOR (WRITE) PERMISSIONS - OPT-IN APP REGISTRATION
#
# The assessment/reader app registration above must stay read-only. Portal write
# workers use a second app registration, M365-Assess-Operator, provisioned only
# when Grant-M365AssessConsent is called with -IncludeWritePermissions and an
# explicit -WritePermissionGroups selection (T-0917).
#
# Groups mirror the write-permission matrix in ISSUES/T-0917.md. A permission
# listed in $script:OperatorDangerousPermissions requires -ConfirmDangerous;
# without it the cmdlet refuses before changing the tenant.
# ==============================================================================

$script:OperatorWriteGroups = [ordered]@{
    identity   = @{
        Description        = 'Users, groups, Conditional Access, authentication methods, PIM role settings and role assignment.'
        GraphPermissions   = @(
            'User.ReadWrite.All'
            'Group.ReadWrite.All'
            'Policy.ReadWrite.ConditionalAccess'
            'Policy.ReadWrite.SecurityDefaults'
            'Policy.ReadWrite.AuthenticationMethod'
            'UserAuthenticationMethod.ReadWrite.All'
            'RoleManagementPolicy.ReadWrite.Directory'
            'RoleAssignmentSchedule.ReadWrite.Directory'
            'RoleEligibilitySchedule.ReadWrite.Directory'
            'Domain.ReadWrite.All'
            'MailboxSettings.ReadWrite'
        )
        ExchangeAppRoles   = @()
        ExoRoleGroups      = @()
        DirectoryRoles     = @()
    }
    security   = @{
        Description        = 'Defender alerts, incidents, and threat submissions.'
        GraphPermissions   = @(
            'SecurityAlert.ReadWrite.All'
            'SecurityIncident.ReadWrite.All'
            'ThreatSubmission.ReadWrite.All'
        )
        ExchangeAppRoles   = @()
        ExoRoleGroups      = @()
        DirectoryRoles     = @()
    }
    intune     = @{
        Description        = 'Intune configuration, apps, service configuration, and managed-device actions.'
        GraphPermissions   = @(
            'DeviceManagementConfiguration.ReadWrite.All'
            'DeviceManagementApps.ReadWrite.All'
            'DeviceManagementServiceConfig.ReadWrite.All'
            'DeviceManagementManagedDevices.ReadWrite.All'
            'DeviceManagementManagedDevices.PrivilegedOperations.All'
        )
        ExchangeAppRoles   = @()
        ExoRoleGroups      = @()
        DirectoryRoles     = @()
    }
    sharepoint = @{
        Description        = 'SharePoint site permissions and property edits, plus Teams creation and settings.'
        GraphPermissions   = @(
            'Sites.FullControl.All'
            'Team.Create'
            'TeamSettings.ReadWrite.All'
        )
        ExchangeAppRoles   = @()
        ExoRoleGroups      = @()
        DirectoryRoles     = @()
    }
    exchange   = @{
        Description        = 'Exchange Online and Purview writes through the Exchange Administrator, eDiscovery Manager, and Teams Administrator roles.'
        GraphPermissions   = @()
        ExchangeAppRoles   = @(
            'Exchange.ManageAsApp'
            'Organization.Read.All'
            'MailboxSettings.Read'
        )
        ExoRoleGroups      = @(
            'Exchange Administrator'
        )
        DirectoryRoles     = @(
            'Exchange Administrator'
            'eDiscovery Manager'
            'Teams Administrator'
        )
    }
}

# Permissions that need -ConfirmDangerous: PIM role assignment (any directory
# role, including Global Administrator), device wipe, and full SharePoint control.
$script:OperatorDangerousPermissions = @(
    'RoleAssignmentSchedule.ReadWrite.Directory'
    'RoleEligibilitySchedule.ReadWrite.Directory'
    'DeviceManagementManagedDevices.PrivilegedOperations.All'
    'Sites.FullControl.All'
)

# Built-in Entra directory role template ids for the operator app. Stable across
# tenants. Exchange Administrator also exists as an EXO role group; when the
# exchange group is selected it is assigned in both surfaces.
$script:OperatorDirectoryRoleTemplates = @{
    'Exchange Administrator' = '29232cdf-9323-42fd-ade2-1d097af3e4de'
    'eDiscovery Manager'     = '5f2222b1-57c3-48ba-8ad5-d4759f1fde6f'
    'Teams Administrator'    = '69091246-20e8-4a56-aa4d-066075b2a7a8'
}

# Resolves the -WritePermissionGroups selection into the exact Graph, Exchange,
# EXO-role, and directory-role grants, and names the dangerous permissions the
# caller must confirm. Pure data selection; no tenant access.
function Get-M365AssessOperatorWriteSelection {
    <#
    .SYNOPSIS
        Resolves the opt-in write groups into the permissions and roles to grant.
    .DESCRIPTION
        Deduplicates the selected groups and returns the Graph application
        permissions, Exchange Online app roles, EXO role groups, directory roles,
        and the dangerous permission subset that requires -ConfirmDangerous.
    .PARAMETER Groups
        Write groups: identity, security, intune, sharepoint, exchange.
    .EXAMPLE
        PS> Get-M365AssessOperatorWriteSelection -Groups @('identity','intune')
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string[]]$Groups
    )

    $selected = @($Groups | ForEach-Object { $_.Trim().ToLowerInvariant() } | Select-Object -Unique)
    $graph = [System.Collections.Generic.List[string]]::new()
    $exchangeAppRoles = [System.Collections.Generic.List[string]]::new()
    $exoRoleGroups = [System.Collections.Generic.List[string]]::new()
    $directoryRoles = [System.Collections.Generic.List[string]]::new()

    foreach ($group in $selected) {
        if (-not $script:OperatorWriteGroups.Contains($group)) {
            $valid = ($script:OperatorWriteGroups.Keys -join ', ')
            throw "Unknown write permission group '$group'. Valid groups: $valid (code: consent.invalid_write_group)."
        }
        $definition = $script:OperatorWriteGroups[$group]
        foreach ($permission in @($definition.GraphPermissions)) {
            if (-not $graph.Contains($permission)) { $graph.Add($permission) }
        }
        foreach ($role in @($definition.ExchangeAppRoles)) {
            if (-not $exchangeAppRoles.Contains($role)) { $exchangeAppRoles.Add($role) }
        }
        foreach ($roleGroup in @($definition.ExoRoleGroups)) {
            if (-not $exoRoleGroups.Contains($roleGroup)) { $exoRoleGroups.Add($roleGroup) }
        }
        foreach ($role in @($definition.DirectoryRoles)) {
            if (-not $directoryRoles.Contains($role)) { $directoryRoles.Add($role) }
        }
    }

    $dangerous = @($graph | Where-Object { $script:OperatorDangerousPermissions -contains $_ })

    return [pscustomobject]@{
        Groups              = $selected
        GraphPermissions    = @($graph)
        ExchangeAppRoles    = @($exchangeAppRoles)
        ExoRoleGroups       = @($exoRoleGroups)
        DirectoryRoles      = @($directoryRoles)
        DangerousPermissions = $dangerous
    }
}
