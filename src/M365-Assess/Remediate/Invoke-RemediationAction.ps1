function Get-RemediationTypedState {
    <#
    .SYNOPSIS
        Reads current tenant state for a typed remediation command.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CommandName,

        [Parameter()]
        [hashtable]$Parameters = @{},

        [Parameter()]
        [object]$TenantCredential
    )

    switch ($CommandName) {
        'Set-EntraSecurityDefaultsState' {
            (Get-MgPolicyIdentitySecurityDefaultsEnforcementPolicy).IsEnabled
        }
        'Set-EntraGuestUserRole' {
            (Get-MgPolicyAuthorizationPolicy).GuestUserRoleId
        }
        'Set-EntraInvitePolicy' {
            (Get-MgPolicyAuthorizationPolicy).AllowInvitesFrom
        }
        'Set-SpoSharingCapability' {
            (Get-SPOTenant).SharingCapability
        }
        'Set-SpoDefaultSharingLinkType' {
            (Get-SPOTenant).DefaultSharingLinkType
        }
        'Set-SpoDefaultLinkPermission' {
            (Get-SPOTenant).DefaultLinkPermission
        }
        default {
            throw [System.NotSupportedException]::new(
                "No state reader for typed command '$CommandName'.")
        }
    }
}

function Invoke-RemediationTypedApply {
    <#
    .SYNOPSIS
        Applies one typed remediation command with bound parameters.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CommandName,

        [Parameter()]
        [hashtable]$Parameters = @{},

        [Parameter()]
        [object]$TenantCredential
    )

    switch ($CommandName) {
        'Set-EntraSecurityDefaultsState' {
            Update-MgPolicyIdentitySecurityDefaultsEnforcementPolicy -IsEnabled ([bool]$Parameters['IsEnabled'])
        }
        'Set-EntraGuestUserRole' {
            Update-MgPolicyAuthorizationPolicy -GuestUserRoleId ([string]$Parameters['GuestUserRoleId'])
        }
        'Set-EntraInvitePolicy' {
            Update-MgPolicyAuthorizationPolicy -AllowInvitesFrom ([string]$Parameters['AllowInvitesFrom'])
        }
        'Set-SpoSharingCapability' {
            Set-SPOTenant -SharingCapability ([string]$Parameters['SharingCapability'])
        }
        'Set-SpoDefaultSharingLinkType' {
            Set-SPOTenant -DefaultSharingLinkType ([string]$Parameters['DefaultSharingLinkType'])
        }
        'Set-SpoDefaultLinkPermission' {
            Set-SPOTenant -DefaultLinkPermission ([string]$Parameters['DefaultLinkPermission'])
        }
        default {
            throw [System.NotSupportedException]::new(
                "No typed apply for command '$CommandName'.")
        }
    }

    Get-RemediationTypedState -CommandName $CommandName -Parameters $Parameters -TenantCredential $TenantCredential
}

function Invoke-RemediationAction {
    <#
    .SYNOPSIS
        Executes one allowlisted remediation action behind gates with confirmation.
    .DESCRIPTION
        Gated executor contract per EPIC-006 SPEC.md section 8 and
        06-remediation.md sections 2.2, 3.2, and 8. The check id resolves to
        a typed command binding via Get-RemediationCommand (hashtable lookup;
        never string evaluation, never Invoke-Expression). Unknown commands
        are refused with state 'not-implemented'. Gates evaluate through
        Test-RemediationGate and any non-planned decision stops the action
        before any tenant call. Confirmation is enforced with
        SupportsShouldProcess (ConfirmImpact High): -WhatIf or -DryRun
        reports the intended change without writing, and a real apply
        captures before/after around the typed call. Tenant credentials reuse
        the EPIC-001 Resolve-TenantCredential seam when available; the
        credential object itself is opaque here because the EPIC-002 model is
        not yet authored, so callers may also pass -TenantCredential through.
    .PARAMETER CheckId
        The finding CheckId, with or without the sub-number suffix.
    .PARAMETER TenantId
        Target tenant for the action. Compared against the caller scope gate.
    .PARAMETER TenantCredential
        Opaque tenant credential passed through to the typed action. When
        omitted and Resolve-TenantCredential is available, it is resolved for
        TenantId.
    .PARAMETER CallerContext
        Caller shape from the BFF (Permissions + TenantScope), passed to the
        gates unchanged.
    .PARAMETER CommandBinding
        Pre-resolved Get-RemediationCommand output. Resolved internally when
        omitted. Accepts caller-supplied bindings so tests can exercise the
        executor without tenant access.
    .PARAMETER LicenseMinimum
        Registry licensing.minimum for the check, passed to the gates.
    .PARAMETER RequiredServicePlans
        Service plan IDs from licensing-overlay.json for the check.
    .PARAMETER TenantServicePlans
        Service plan IDs active in the target tenant.
    .PARAMETER ServiceAvailable
        Whether the backing service for the check section is connected.
    .PARAMETER TenantReadOnly
        Tenant or global read-only flag.
    .PARAMETER RequiredPermission
        Permission the caller must hold. Defaults to remediation.apply.
    .PARAMETER AllowlistPath
        Path to the admin-managed allowlist file. Used unless
        AllowlistCheckIds is supplied.
    .PARAMETER AllowlistCheckIds
        Explicit allowlist membership, forwarded to the gates.
    .PARAMETER Actor
        Optional caller identity recorded on the result.
    .PARAMETER DryRun
        Explicit dry-run switch with the same semantics as -WhatIf: capture
        before, report the intended change, write nothing.
    .PARAMETER GetState
        Test seam: scriptblock returning current state instead of calling the
        tenant. Production callers omit it.
    .PARAMETER ApplyChange
        Test seam: scriptblock performing the change and returning the
        post-apply state instead of calling the tenant. Never invoked on the
        dry-run path. Production callers omit it.
    .OUTPUTS
        [PSCustomObject] with CheckId, RegistryKey, TenantId, State
        (dryrun | applied | skipped | rejected | failed | not-implemented),
        Reason, CommandName, Parameters, Before, After, IntendedChange,
        DryRun, Actor, AppliedAt, and GateDecision.
    .EXAMPLE
        Invoke-RemediationAction -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' -CallerContext $ctx -AllowlistCheckIds @('SPO-SHARING-001') -WhatIf
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter()]
        [string]$TenantId,

        [Parameter()]
        [object]$TenantCredential,

        [Parameter()]
        [object]$CallerContext,

        [Parameter()]
        [object]$CommandBinding,

        [Parameter()]
        [string]$LicenseMinimum,

        [Parameter()]
        [string[]]$RequiredServicePlans = @(),

        [Parameter()]
        [string[]]$TenantServicePlans = @(),

        [Parameter()]
        [bool]$ServiceAvailable = $true,

        [Parameter()]
        [bool]$TenantReadOnly = $false,

        [Parameter()]
        [string]$RequiredPermission = 'remediation.apply',

        [Parameter()]
        [string]$AllowlistPath,

        [Parameter()]
        [string[]]$AllowlistCheckIds,

        [Parameter()]
        [string]$Actor,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [scriptblock]$GetState,

        [Parameter()]
        [scriptblock]$ApplyChange
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''
        $appliedAt = (Get-Date).ToUniversalTime().ToString('o')

        if ($null -eq $CommandBinding) {
            $bindingCommand = Get-Command -Name Get-RemediationCommand -ErrorAction SilentlyContinue
            if ($null -eq $bindingCommand) {
                . (Join-Path -Path $PSScriptRoot -ChildPath 'Get-RemediationCommand.ps1')
            }
            $CommandBinding = Get-RemediationCommand -CheckId $CheckId
        }

        if ($CommandBinding.Kind -ne 'typed') {
            [PSCustomObject]@{
                CheckId       = $CheckId
                RegistryKey   = $registryKey
                TenantId      = $TenantId
                State         = 'not-implemented'
                Reason        = 'not-implemented'
                CommandName   = $CommandBinding.CommandName
                Parameters    = $CommandBinding.Parameters
                Before        = $null
                After         = $null
                IntendedChange = $null
                DryRun        = $false
                Actor         = $Actor
                AppliedAt     = $appliedAt
                GateDecision  = $null
            }
            return
        }

        if ($null -eq $TenantCredential -and -not [string]::IsNullOrWhiteSpace($TenantId)) {
            $credentialCommand = Get-Command -Name Resolve-TenantCredential -ErrorAction SilentlyContinue
            if ($null -ne $credentialCommand) {
                $TenantCredential = Resolve-TenantCredential -TenantId $TenantId
            }
        }

        $gateCommand = Get-Command -Name Test-RemediationGate -ErrorAction SilentlyContinue
        if ($null -eq $gateCommand) {
            . (Join-Path -Path $PSScriptRoot -ChildPath 'Test-RemediationGate.ps1')
        }
        $gateParams = @{
            CheckId              = $CheckId
            ServiceAvailable     = $ServiceAvailable
            TenantReadOnly       = $TenantReadOnly
            RequiredPermission   = $RequiredPermission
        }
        if (-not [string]::IsNullOrWhiteSpace($TenantId)) { $gateParams['TenantId'] = $TenantId }
        if ($null -ne $CallerContext) { $gateParams['CallerContext'] = $CallerContext }
        if (-not [string]::IsNullOrWhiteSpace($LicenseMinimum)) { $gateParams['LicenseMinimum'] = $LicenseMinimum }
        if ($RequiredServicePlans.Count -gt 0) { $gateParams['RequiredServicePlans'] = $RequiredServicePlans }
        if ($TenantServicePlans.Count -gt 0) { $gateParams['TenantServicePlans'] = $TenantServicePlans }
        if (-not [string]::IsNullOrWhiteSpace($AllowlistPath)) { $gateParams['AllowlistPath'] = $AllowlistPath }
        if ($null -ne $AllowlistCheckIds) { $gateParams['AllowlistCheckIds'] = $AllowlistCheckIds }
        if (-not [string]::IsNullOrWhiteSpace($Actor)) { $gateParams['Actor'] = $Actor }
        $gateDecision = Test-RemediationGate @gateParams

        if ($gateDecision.Decision -ne 'planned') {
            [PSCustomObject]@{
                CheckId        = $CheckId
                RegistryKey    = $registryKey
                TenantId       = $TenantId
                State          = $gateDecision.Decision
                Reason         = $gateDecision.Reason
                CommandName    = $CommandBinding.CommandName
                Parameters     = $CommandBinding.Parameters
                Before         = $null
                After          = $null
                IntendedChange = $null
                DryRun         = $false
                Actor          = $Actor
                AppliedAt      = $appliedAt
                GateDecision   = $gateDecision
            }
            return
        }

        $readParams = @{
            CommandName      = $CommandBinding.CommandName
            Parameters       = $CommandBinding.Parameters
            TenantCredential = $TenantCredential
        }
        if ($null -ne $GetState) {
            $before = & $GetState
        }
        else {
            $before = Get-RemediationTypedState @readParams
        }

        $targetDescription = if ([string]::IsNullOrWhiteSpace($TenantId)) { "check $registryKey" } else { "check $registryKey on tenant $TenantId" }
        $operationDescription = "Apply remediation $($CommandBinding.CommandName)"

        if ($DryRun.IsPresent -or -not $PSCmdlet.ShouldProcess($targetDescription, $operationDescription)) {
            [PSCustomObject]@{
                CheckId        = $CheckId
                RegistryKey    = $registryKey
                TenantId       = $TenantId
                State          = 'dryrun'
                Reason         = 'dryrun'
                CommandName    = $CommandBinding.CommandName
                Parameters     = $CommandBinding.Parameters
                Before         = $before
                After          = $null
                IntendedChange = $CommandBinding.Parameters
                DryRun         = $true
                Actor          = $Actor
                AppliedAt      = $appliedAt
                GateDecision   = $gateDecision
            }
            return
        }

        try {
            if ($null -ne $ApplyChange) {
                $after = & $ApplyChange
            }
            else {
                $after = Invoke-RemediationTypedApply @readParams
            }
        }
        catch {
            [PSCustomObject]@{
                CheckId        = $CheckId
                RegistryKey    = $registryKey
                TenantId       = $TenantId
                State          = 'failed'
                Reason         = $_.Exception.Message
                CommandName    = $CommandBinding.CommandName
                Parameters     = $CommandBinding.Parameters
                Before         = $before
                After          = $null
                IntendedChange = $null
                DryRun         = $false
                Actor          = $Actor
                AppliedAt      = $appliedAt
                GateDecision   = $gateDecision
            }
            return
        }

        [PSCustomObject]@{
            CheckId        = $CheckId
            RegistryKey    = $registryKey
            TenantId       = $TenantId
            State          = 'applied'
            Reason         = $null
            CommandName    = $CommandBinding.CommandName
            Parameters     = $CommandBinding.Parameters
            Before         = $before
            After          = $after
            IntendedChange = $null
            DryRun         = $false
            Actor          = $Actor
            AppliedAt      = $appliedAt
            GateDecision   = $gateDecision
        }
    }
}
