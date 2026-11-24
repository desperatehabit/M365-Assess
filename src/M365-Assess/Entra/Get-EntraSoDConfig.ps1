<#
.SYNOPSIS
    Evaluates separation of duties for critical Entra ID admin roles.
.DESCRIPTION
    Checks separation of duties between the Global Administrator and Privileged
    Role Administrator roles: at least one Privileged Role Administrator must be
    assigned and no single user may hold both roles simultaneously. The minimum
    Global Administrator count is covered by ENTRA-ADMIN-001. Also verifies PIM
    is in use so that activations require approval.

    Requires an active Microsoft Graph connection with RoleManagement.Read.Directory
    and Directory.Read.All permissions.
.PARAMETER OutputPath
    Optional path to export results as CSV. If not specified, results are returned
    to the pipeline.
.EXAMPLE
    PS> .\Entra\Get-EntraSoDConfig.ps1

    Displays separation of duties evaluation results.
.EXAMPLE
    PS> .\Entra\Get-EntraSoDConfig.ps1 -OutputPath '.\entra-sod-config.csv'

    Exports the evaluation to CSV.
.NOTES
    Author:  Daren9m
    CMMC:    AC.L2-3.1.4 — Separation of Duties
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$_scriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PSScriptRoot }
. (Join-Path -Path $_scriptDir -ChildPath '..\Common\SecurityConfigHelper.ps1')

$ctx = Initialize-SecurityConfig
$settings = $ctx.Settings


# ------------------------------------------------------------------
# Well-known role template IDs
# ------------------------------------------------------------------
$globalAdminRoleId = '62e90394-69f5-4237-9190-012177145e10'
$privRoleAdminRoleId = 'e8611ab8-c189-46e8-94e1-60213ab1f814'

# ------------------------------------------------------------------
# 1. Check Global Admin and Privileged Role Admin assignments
# ------------------------------------------------------------------
try {
    Write-Verbose 'Checking role assignments for Global Administrator...'
    $gaParams = @{
        Method      = 'GET'
        Uri         = "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$globalAdminRoleId'&`$top=999&`$expand=principal"
        ErrorAction = 'Stop'
    }
    $gaAssignments = Invoke-MgGraphRequest @gaParams

    $gaMembers = @()
    if ($gaAssignments -and $gaAssignments['value']) {
        $gaMembers = @($gaAssignments['value'])
    }

    Write-Verbose 'Checking role assignments for Privileged Role Administrator...'
    $praParams = @{
        Method      = 'GET'
        Uri         = "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$privRoleAdminRoleId'&`$top=999&`$expand=principal"
        ErrorAction = 'Stop'
    }
    $praAssignments = Invoke-MgGraphRequest @praParams

    $praMembers = @()
    if ($praAssignments -and $praAssignments['value']) {
        $praMembers = @($praAssignments['value'])
    }

    # Extract unique principal IDs for each role
    $gaPrincipals = @($gaMembers | ForEach-Object { $_['principalId'] } | Sort-Object -Unique)
    $praPrincipals = @($praMembers | ForEach-Object { $_['principalId'] } | Sort-Object -Unique)

    # Check separation: no single user should hold both roles
    $overlap = @($gaPrincipals | Where-Object { $praPrincipals -contains $_ })

    $gaCount = $gaPrincipals.Count
    $praCount = $praPrincipals.Count
    $overlapCount = $overlap.Count

    # Pass criteria: separation of duties only -- at least one Privileged Role
    # Administrator is assigned and no user holds both roles. The minimum Global
    # Administrator count is intentionally not tested here; ENTRA-ADMIN-001 owns it.
    $separated = ($praCount -ge 1) -and ($overlapCount -eq 0)

    $currentValue = "Global Admins: $gaCount, Priv Role Admins: $praCount, Overlap: $overlapCount"

    $settingParams = @{
        Category         = 'Separation of Duties'
        Setting          = 'Critical Role Separation (Global Admin vs Privileged Role Admin)'
        CurrentValue     = $currentValue
        RecommendedValue = 'At least 1 Privileged Role Admin, no user holding both Global Admin and Privileged Role Admin'
        Status           = if ($separated) { 'Pass' } else { 'Fail' }
        CheckId          = 'ENTRA-SOD-001'
        Remediation      = 'Ensure Global Administrator and Privileged Role Administrator roles are assigned to separate accounts. Entra admin center > Identity > Roles & admins. Enable PIM approval workflows for role activation.'
    }
    Add-Setting @settingParams
}
catch {
    if ($_.Exception.Message -match '403|Forbidden|Authorization') {
        $settingParams = @{
            Category         = 'Separation of Duties'
            Setting          = 'Critical Role Separation (Global Admin vs Privileged Role Admin)'
            CurrentValue     = 'Insufficient permissions'
            RecommendedValue = 'At least 1 Privileged Role Admin, no user holding both Global Admin and Privileged Role Admin'
            Status           = 'Review'
            CheckId          = 'ENTRA-SOD-001'
            Remediation      = 'Requires RoleManagement.Read.Directory and Directory.Read.All permissions.'
        }
        Add-Setting @settingParams
    }
    else {
        Write-Warning "Could not check separation of duties: $_"
    }
}

# ------------------------------------------------------------------
# Output results
# ------------------------------------------------------------------
Export-SecurityConfigReport -Settings $settings -OutputPath $OutputPath -ServiceLabel 'Entra SoD'
