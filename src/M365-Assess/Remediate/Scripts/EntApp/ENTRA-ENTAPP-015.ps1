<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-015: Service principals with client secret and permanent privileged directory role
.DESCRIPTION
    For privileged service principals that have a client secret and a permanent directory role,
    removes the secrets or removes the role assignments.

    Desired state: No listed service principal combines a secret with a permanent role
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All, RoleManagement.ReadWrite.Directory.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ServicePrincipalId
    Object IDs of the enterprise applications (service principals) to change, from the assessment
    finding or Enterprise applications > Properties > Object ID.
.PARAMETER Action
    RemoveSecrets: delete the service principal's (and its app registration's) client secrets;
    switch it to a certificate or managed identity first. RemoveRoles: delete its permanent
    directory role assignments; use PIM or narrower Graph permissions instead.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-015.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -Action RemoveSecrets -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-015.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -Action RemoveSecrets
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
    [ValidateSet('RemoveSecrets', 'RemoveRoles')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Application.ReadWrite.All', 'RoleManagement.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-ENTAPP-015'
    Target    = 'Listed service principals with secret + permanent role'
    Desired   = "Resolved by $Action"
    GetState  = {
        @(foreach ($id in $ServicePrincipalId) {
            $sp = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/servicePrincipals/$id`?`$select=id,appId,displayName,passwordCredentials" -OutputType HashTable
            $roles = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$id'" -OutputType HashTable)['value']) | Where-Object { $_ }
            $app = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/applications?`$filter=appId eq '$($sp['appId'])'&`$select=id,passwordCredentials" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
            $spSecrets = @($sp['passwordCredentials'] | Where-Object { $_ } | ForEach-Object { "$($_['keyId'])" })
            $appSecrets = @($app['passwordCredentials'] | Where-Object { $_ } | ForEach-Object { "$($_['keyId'])" })
            if (($spSecrets.Count + $appSecrets.Count) -gt 0 -and @($roles).Count -gt 0) {
                [PSCustomObject]@{ Id = $id; DisplayName = $sp['displayName']; AppObjectId = $app['id']; SpSecrets = $spSecrets; AppSecrets = $appSecrets; RoleAssignmentIds = @($roles | ForEach-Object { $_['id'] }) }
            }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($finding in $State) {
            if ($Action -eq 'RemoveSecrets') {
                Remove-RemediationAppCredential -ObjectId $finding.Id -SecretKeyId $finding.SpSecrets -ServicePrincipal
                if ($finding.AppObjectId) { Remove-RemediationAppCredential -ObjectId $finding.AppObjectId -SecretKeyId $finding.AppSecrets }
            }
            else {
                foreach ($assignmentId in $finding.RoleAssignmentIds) { Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/roleManagement/directory/roleAssignments/$assignmentId" | Out-Null }
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
