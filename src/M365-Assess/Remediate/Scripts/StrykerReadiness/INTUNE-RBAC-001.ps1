<#
.SYNOPSIS
    Remediates INTUNE-RBAC-001: RBAC role assignments without scope tags
.DESCRIPTION
    Limits the Intune role assignments you name to the groups of users/devices they should manage
    (scope groups), and optionally to scope tags.

    Desired state: Listed role assignments are scoped
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementRBAC.ReadWrite.All.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RoleAssignmentId
    IDs of the Intune role assignments to scope.
.PARAMETER ScopeGroupId
    Groups of users/devices the assigned admins may manage.
.PARAMETER ScopeTagId
    Scope tag IDs to add, limiting which objects the admins can see.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/INTUNE-RBAC-001.ps1 -RoleAssignmentId '<id>' -ScopeGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/INTUNE-RBAC-001.ps1 -RoleAssignmentId '<id>' -ScopeGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$RoleAssignmentId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ScopeGroupId,

    [Parameter()]
    [string[]]$ScopeTagId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementRBAC.ReadWrite.All'

$step = @{
    CheckId   = 'INTUNE-RBAC-001'
    Target    = 'Listed Intune role assignments'
    Desired   = 'Scoped to -ScopeGroupId'
    GetState  = {
        @(foreach ($id in $RoleAssignmentId) {
            $a = Invoke-MgGraphRequest -Method GET -Uri "/beta/deviceManagement/roleAssignments/$id" -OutputType HashTable
            $scopes = @($a['resourceScopes'])
            $broad = $scopes.Count -eq 0 -or ($scopes.Count -eq 1 -and "$($scopes[0])" -eq '0') -or @($ScopeGroupId | Where-Object { $scopes -notcontains $_ }).Count -gt 0
            $tagsMissing = @($ScopeTagId | Where-Object { $_ -and @($a['roleScopeTagIds']) -notcontains $_ }).Count -gt 0
            if ($broad -or $tagsMissing) { [PSCustomObject]@{ Id = $id; DisplayName = $a['displayName']; ResourceScopes = $scopes; RoleScopeTagIds = @($a['roleScopeTagIds']) } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($a in $State) {
            $body = @{ '@odata.type' = '#microsoft.graph.deviceAndAppManagementRoleAssignment'; resourceScopes = @($ScopeGroupId); scopeType = 'resourceScope' }
            if (@($ScopeTagId | Where-Object { $_ }).Count -gt 0) { $body['roleScopeTagIds'] = @(@($a.RoleScopeTagIds) + $ScopeTagId | Where-Object { $_ } | Sort-Object -Unique) }
            Set-RemediationGraphObject -Uri "/beta/deviceManagement/roleAssignments/$($a.Id)" -Body $body
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
