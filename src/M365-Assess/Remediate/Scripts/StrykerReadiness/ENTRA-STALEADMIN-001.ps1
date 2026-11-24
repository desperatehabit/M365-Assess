<#
.SYNOPSIS
    Remediates ENTRA-STALEADMIN-001: Admin accounts inactive for more than 90 days
.DESCRIPTION
    Disables, or removes the roles of, privileged admin accounts with no sign-in for 90 days or
    more. Break-glass accounts are never touched.

    Desired state: No privileged admin inactive past -InactiveDays
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: User.ReadWrite.All, AuditLog.Read.All, RoleManagement.ReadWrite.Directory.

    Only direct role assignments are evaluated. Remove stale PIM eligible assignments in PIM.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER BreakGlassAccountId
    Object IDs of emergency-access accounts, which are always left alone.
.PARAMETER Action
    Disable the account, or remove its directory role assignments.
.PARAMETER InactiveDays
    Days without sign-in that count as stale.
.PARAMETER RoleDefinitionId
    Privileged role template IDs to evaluate. Defaults to the core admin roles listed in the script.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-STALEADMIN-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -Action Disable -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-STALEADMIN-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -Action Disable
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$BreakGlassAccountId,

    [Parameter(Mandatory)]
    [ValidateSet('Disable', 'RemoveRoles')]
    [string]$Action,

    [Parameter()]
    [ValidateRange(30, 3650)]
    [int]$InactiveDays = 90,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string[]]$RoleDefinitionId = @(
    '62e90394-69f5-4237-9190-012177145e10', # Global Administrator
    'e8611ab8-c189-46e8-94e1-60213ab1f814', # Privileged Role Administrator
    '7be44c8a-adaf-4e2a-84d6-ab2649e08a13', # Privileged Authentication Administrator
    '194ae4cb-b126-40b2-bd5b-6091b380977d', # Security Administrator
    'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9', # Conditional Access Administrator
    '3a2c62db-5318-420d-8d74-23affee5d9d5', # Intune Administrator
    '29232cdf-9323-42fd-ade2-1d097af3e4de', # Exchange Administrator
    'fe930be7-5e62-47db-91af-98c3a49a38b1', # User Administrator
    '158c047a-c907-4556-b7ef-446551a6b5f7', # Cloud Application Administrator
    '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3' # Application Administrator
)
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'User.ReadWrite.All', 'AuditLog.Read.All', 'RoleManagement.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-STALEADMIN-001'
    Target    = 'Stale privileged admin accounts'
    Desired   = "Handled by $Action"
    GetState  = {
        $cutoff = (Get-Date).ToUniversalTime().AddDays(-$InactiveDays)
        @($(foreach ($roleId in $RoleDefinitionId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'" -OutputType HashTable)['value']) | Where-Object { $_ }
        }) | Group-Object -Property { $_['principalId'] } | ForEach-Object {
            $id = $_.Name
            if (@($BreakGlassAccountId) -contains $id) { return }
            $user = Invoke-MgGraphRequest -Method GET -Uri "/beta/users/$id`?`$select=id,userPrincipalName,accountEnabled,signInActivity" -OutputType HashTable -ErrorAction SilentlyContinue
            if ($null -eq $user -or $null -eq $user['userPrincipalName']) { return }
            $last = $user['signInActivity']['lastSignInDateTime']
            $stale = $null -eq $last -or [datetime]$last -lt $cutoff
            $pending = if ($Action -eq 'Disable') { $user['accountEnabled'] -ne $false } else { $true }
            if ($stale -and $pending) { [PSCustomObject]@{ Id = $id; UserPrincipalName = $user['userPrincipalName']; LastSignIn = $last; AssignmentIds = @($_.Group | ForEach-Object { $_['id'] }) } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($admin in $State) {
            if ($Action -eq 'Disable') { Set-RemediationGraphObject -Uri "/v1.0/users/$($admin.Id)" -Body @{ accountEnabled = $false } }
            else { foreach ($a in $admin.AssignmentIds) { Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/roleManagement/directory/roleAssignments/$a" | Out-Null } }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
