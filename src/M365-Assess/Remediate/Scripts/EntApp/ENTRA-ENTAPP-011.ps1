<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-011: Foreign apps with Tier 1 data access permissions (Mail, Files, Sites)
.DESCRIPTION
    Removes Tier-1 data-access application permissions (Mail, Files, Sites, and similar) from the
    third-party apps you name.

    Desired state: Listed permissions removed
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: AppRoleAssignment.ReadWrite.All, Application.Read.All.

    The app loses the permission immediately. Removed assignments are returned in Before;
    re-grant with New-MgServicePrincipalAppRoleAssignment if needed.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ServicePrincipalId
    Object IDs of the enterprise applications (service principals) to change, from the assessment
    finding or Enterprise applications > Properties > Object ID.
.PARAMETER Permission
    Permission names to remove, as listed in the finding (e.g. 'RoleManagement.ReadWrite.Directory',
    'Mail.ReadWrite'). Use '*' to remove every application permission the app holds.
.PARAMETER ResourceAppId
    appId of the API the permissions belong to. Defaults to Microsoft Graph.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-011.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -Permission 'RoleManagement.ReadWrite.Directory' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-011.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -Permission 'RoleManagement.ReadWrite.Directory'
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

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Permission,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceAppId = '00000003-0000-0000-c000-000000000000'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'AppRoleAssignment.ReadWrite.All', 'Application.Read.All'

$step = @{
    CheckId   = 'ENTRA-ENTAPP-011'
    Target    = 'Application permission assignments on the listed apps'
    Desired   = 'Removed'
    GetState  = {
        $resource = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/servicePrincipals?`$filter=appId eq '$ResourceAppId'&`$select=id,appRoles,oauth2PermissionScopes" -OutputType HashTable)['value'])[0]
        $roleNames = @{}
        foreach ($role in @($resource['appRoles'])) { $roleNames["$($role['id'])"] = $role['value'] }
        @(foreach ($id in $ServicePrincipalId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/servicePrincipals/$id/appRoleAssignments" -OutputType HashTable)['value']) |
                Where-Object { $null -ne $_ -and $_['resourceId'] -eq $resource['id'] -and (@($Permission) -contains '*' -or @($Permission) -contains $roleNames["$($_['appRoleId'])"]) } |
                ForEach-Object { [PSCustomObject]@{ ServicePrincipalId = $id; AssignmentId = $_['id']; Permission = $roleNames["$($_['appRoleId'])"]; PrincipalDisplayName = $_['principalDisplayName'] } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($assignment in $State) {
            Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/servicePrincipals/$($assignment.ServicePrincipalId)/appRoleAssignments/$($assignment.AssignmentId)" | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
