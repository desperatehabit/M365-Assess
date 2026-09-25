function Test-RemediationGate {
    <#
    .SYNOPSIS
        Evaluates the six remediation preconditions for one automated action.
    .DESCRIPTION
        Implements EPIC-006 SPEC.md section 4.1 step 5 and section 7 plus
        06-remediation.md section 4: every automated action passes six gates
        and records the unmet reason. RBAC and tenant-scope failures are
        rejections (HTTP 403); the remaining unmet gates are skips with a
        distinct reason. Gates evaluate in rejection-first order
        (RBAC, scope) then license, service, read-only, allowlist.

        The caller context (permissions + tenant scope) is passed in from the
        BFF, which owns the RBAC seam (T-0013); this function only intersects
        and never widens. The CheckId is stripped to the registry key exactly
        like Resolve-Remediation (T-0102). License inputs come from
        licensing-overlay.json / registry licensing.minimum via
        Resolve-Remediation; allowlist membership comes from
        Get-RemediationAllowlist (load-only config).
    .PARAMETER CheckId
        The finding CheckId, with or without the sub-number suffix.
    .PARAMETER TenantId
        Target tenant for the action. Compared against the caller scope.
    .PARAMETER CallerContext
        Caller shape from the BFF: Permissions (string array, must contain
        RequiredPermission) and TenantScope (has All [bool] plus TenantIds
        [string array], mirroring the T-0013 TenantScope).
    .PARAMETER LicenseMinimum
        Registry licensing.minimum for the check (E3, E5, or empty).
    .PARAMETER RequiredServicePlans
        Service plan IDs from licensing-overlay.json for the check.
    .PARAMETER TenantServicePlans
        Service plan IDs active in the target tenant. When no overlay plans
        exist for the check, must contain the LicenseMinimum level itself.
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
        Explicit allowlist membership for callers (tests, workers) that
        already resolved the file via Get-RemediationAllowlist.
    .PARAMETER Actor
        Optional caller identity recorded on the audit record.
    .OUTPUTS
        [PSCustomObject] with CheckId, RegistryKey, TenantId, Decision
        (planned, skipped, rejected), Reason, StatusCode, Allowlisted, and
        AuditRecord (every decision, including the allowlist result).
    .EXAMPLE
        Test-RemediationGate -CheckId 'COMPLIANCE-AUDIT-001.1' -TenantId 'tenant-a' -CallerContext @{ Permissions = @('remediation.apply'); TenantScope = @{ All = $true; TenantIds = @() } } -LicenseMinimum 'E3' -AllowlistCheckIds @('COMPLIANCE-AUDIT-001')
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter()]
        [string]$TenantId,

        [Parameter()]
        [object]$CallerContext,

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
        [string]$Actor
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''

        $decision = 'planned'
        $reason = $null
        $statusCode = 200

        $callerPermissions = @()
        $scopeAll = $false
        $scopeTenantIds = @()
        if ($null -ne $CallerContext) {
            $rawPermissions = $CallerContext.Permissions
            if ($null -eq $rawPermissions) { $rawPermissions = $CallerContext.permissions }
            if ($null -ne $rawPermissions) { $callerPermissions = @($rawPermissions | ForEach-Object { [string]$_ }) }
            $scope = $CallerContext.TenantScope
            if ($null -eq $scope) { $scope = $CallerContext.tenantScope }
            if ($null -eq $scope) { $scope = $CallerContext.Scope }
            if ($null -ne $scope) {
                if ($null -ne $scope.All) { $scopeAll = [bool]$scope.All }
                elseif ($null -ne $scope.all) { $scopeAll = [bool]$scope.all }
                $rawIds = $scope.TenantIds
                if ($null -eq $rawIds) { $rawIds = $scope.tenantIds }
                if ($null -ne $rawIds) { $scopeTenantIds = @($rawIds | ForEach-Object { [string]$_ }) }
            }
        }

        if ($callerPermissions -notcontains $RequiredPermission) {
            $decision = 'rejected'
            $reason = 'rbac-denied'
            $statusCode = 403
        }
        elseif (-not [string]::IsNullOrWhiteSpace($TenantId)) {
            $inScope = $scopeAll -or ($scopeTenantIds -contains $TenantId)
            if (-not $inScope) {
                $decision = 'rejected'
                $reason = 'tenant-out-of-scope'
                $statusCode = 403
            }
        }

        if ($decision -eq 'planned') {
            $overlayPlans = @($RequiredServicePlans | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            if ($overlayPlans.Count -gt 0) {
                $tenantPlans = @($TenantServicePlans | ForEach-Object { [string]$_ })
                $matched = @($overlayPlans | Where-Object { $tenantPlans -contains $_ })
                if ($matched.Count -eq 0) {
                    $decision = 'skipped'
                    $reason = 'license-missing'
                }
            }
            elseif ($LicenseMinimum -eq 'E5') {
                $tenantPlans = @($TenantServicePlans | ForEach-Object { [string]$_ })
                if ($tenantPlans -notcontains 'E5') {
                    $decision = 'skipped'
                    $reason = 'license-missing'
                }
            }
        }

        if ($decision -eq 'planned' -and -not $ServiceAvailable) {
            $decision = 'skipped'
            $reason = 'service-unavailable'
        }

        if ($decision -eq 'planned' -and $TenantReadOnly) {
            $decision = 'skipped'
            $reason = 'tenant-readonly'
        }

        $allowlisted = $null
        $allowlistAudit = $null
        if ($decision -eq 'planned' -or $true) {
            if ($null -ne $AllowlistCheckIds) {
                $allowlisted = [bool]($AllowlistCheckIds -contains $registryKey)
            }
            else {
                $allowlistCommand = Get-Command -Name Get-RemediationAllowlist -ErrorAction SilentlyContinue
                if ($null -ne $allowlistCommand) {
                    $allowlistParams = @{ CheckId = $CheckId }
                    if (-not [string]::IsNullOrWhiteSpace($AllowlistPath)) { $allowlistParams['AllowlistPath'] = $AllowlistPath }
                    if (-not [string]::IsNullOrWhiteSpace($Actor)) { $allowlistParams['Actor'] = $Actor }
                    $allowlistResult = Get-RemediationAllowlist @allowlistParams
                    $allowlisted = [bool]$allowlistResult.IsAllowlisted
                    $allowlistAudit = $allowlistResult.AuditRecord
                }
                else {
                    $allowlistScript = Join-Path -Path $PSScriptRoot -ChildPath 'Get-RemediationAllowlist.ps1'
                    if (Test-Path -Path $allowlistScript -PathType Leaf) {
                        . $allowlistScript
                        $allowlistParams = @{ CheckId = $CheckId }
                        if (-not [string]::IsNullOrWhiteSpace($AllowlistPath)) { $allowlistParams['AllowlistPath'] = $AllowlistPath }
                        if (-not [string]::IsNullOrWhiteSpace($Actor)) { $allowlistParams['Actor'] = $Actor }
                        $allowlistResult = Get-RemediationAllowlist @allowlistParams
                        $allowlisted = [bool]$allowlistResult.IsAllowlisted
                        $allowlistAudit = $allowlistResult.AuditRecord
                    }
                }
            }
        }

        if ($decision -eq 'planned' -and $null -ne $allowlisted -and -not $allowlisted) {
            $decision = 'skipped'
            $reason = 'not-allowlisted'
        }

        $auditRecord = [PSCustomObject]@{
            EvaluatedAt     = (Get-Date).ToUniversalTime().ToString('o')
            Actor           = $Actor
            CheckId         = $CheckId
            RegistryKey     = $registryKey
            TenantId        = $TenantId
            Decision        = $decision
            Reason          = $reason
            StatusCode      = $statusCode
            Allowlisted     = $allowlisted
            AllowlistAccess = $allowlistAudit
        }

        [PSCustomObject]@{
            CheckId     = $CheckId
            RegistryKey = $registryKey
            TenantId    = $TenantId
            Decision    = $decision
            Reason      = $reason
            StatusCode  = $statusCode
            Allowlisted = $allowlisted
            AuditRecord = $auditRecord
        }
    }
}
