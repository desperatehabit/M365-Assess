<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-005: Foreign apps with Entra directory roles
.DESCRIPTION
    Removes Entra directory role assignments from the third-party apps you name.

    Desired state: No directory roles on the listed service principals
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleManagement.ReadWrite.Directory.

    Grant the narrowest Graph application permission the workload needs instead of a role.
    Removed assignments are returned in Before.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ServicePrincipalId
    Object IDs of the enterprise applications (service principals) to change, from the assessment
    finding or Enterprise applications > Properties > Object ID.
.PARAMETER RoleDefinitionId
    Only remove these roles. Defaults to every directory role the service principal holds.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-005.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-005.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ServicePrincipalId,

    [Parameter()]
    [string[]]$RoleDefinitionId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'RoleManagement.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-ENTAPP-005'
    Target    = 'Directory role assignments on the listed service principals'
    Desired   = 'Removed'
    GetState  = {
        @(foreach ($id in $ServicePrincipalId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$id'" -OutputType HashTable)['value']) |
                Where-Object { $null -ne $_ -and (@($RoleDefinitionId | Where-Object { $_ }).Count -eq 0 -or @($RoleDefinitionId) -contains $_['roleDefinitionId']) } |
                ForEach-Object { [PSCustomObject]@{ AssignmentId = $_['id']; PrincipalId = $id; RoleDefinitionId = $_['roleDefinitionId']; DirectoryScopeId = $_['directoryScopeId'] } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($assignment in $State) { Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/roleManagement/directory/roleAssignments/$($assignment.AssignmentId)" | Out-Null }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
