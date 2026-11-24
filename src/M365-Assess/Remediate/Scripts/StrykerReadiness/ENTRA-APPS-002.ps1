<#
.SYNOPSIS
    Remediates ENTRA-APPS-002: App registrations with dangerous Intune write permissions
.DESCRIPTION
    Removes Intune write permissions (device configuration, managed devices, wipe, apps, RBAC,
    scripts) from the apps you name. A compromised app with these can wipe or reconfigure every device.

    Desired state: Listed apps hold no Intune write permissions
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: AppRoleAssignment.ReadWrite.All, Application.Read.All.

    Approved automation that needs one of these should keep it with an owner, monitoring, and a
    certificate credential. Removed assignments are returned in Before.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ServicePrincipalId
    Object IDs of the enterprise applications (service principals) to change, from the assessment
    finding or Enterprise applications > Properties > Object ID.
.PARAMETER Permission
    Permissions to remove. Defaults to the Intune write permissions listed in the script.
.PARAMETER ResourceAppId
    appId of the API the permissions belong to. Defaults to Microsoft Graph.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-APPS-002.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-APPS-002.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001'
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
    [ValidateNotNullOrEmpty()]
    [string[]]$Permission = @(
    'DeviceManagementConfiguration.ReadWrite.All',
    'DeviceManagementManagedDevices.ReadWrite.All',
    'DeviceManagementManagedDevices.PrivilegedOperations.All',
    'DeviceManagementApps.ReadWrite.All',
    'DeviceManagementRBAC.ReadWrite.All',
    'DeviceManagementServiceConfig.ReadWrite.All',
    'DeviceManagementScripts.ReadWrite.All'
),

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceAppId = '00000003-0000-0000-c000-000000000000'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'AppRoleAssignment.ReadWrite.All', 'Application.Read.All'

$step = @{
    CheckId   = 'ENTRA-APPS-002'
    Target    = 'Intune write permissions on the listed apps'
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
