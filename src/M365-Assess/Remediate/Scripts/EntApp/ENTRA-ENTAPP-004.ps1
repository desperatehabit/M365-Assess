<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-004: Foreign apps with dangerous delegated permissions
.DESCRIPTION
    Removes the dangerous delegated permissions you name from tenant-wide and per-user grants of
    the third-party apps you name. Grants left with no permissions are deleted.

    Desired state: Listed delegated permissions removed
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DelegatedPermissionGrant.ReadWrite.All.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ServicePrincipalId
    Object IDs of the enterprise applications (service principals) to change, from the assessment
    finding or Enterprise applications > Properties > Object ID.
.PARAMETER Permission
    Delegated scopes to remove (e.g. 'Mail.ReadWrite', 'Directory.AccessAsUser.All'), or '*' for all.
.PARAMETER ResourceAppId
    appId of the API. Defaults to Microsoft Graph.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-004.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -Permission 'Mail.ReadWrite' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-004.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -Permission 'Mail.ReadWrite'
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
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DelegatedPermissionGrant.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-ENTAPP-004'
    Target    = 'Delegated grants on the listed apps'
    Desired   = 'Listed scopes removed'
    GetState  = {
        $resource = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/servicePrincipals?`$filter=appId eq '$ResourceAppId'&`$select=id" -OutputType HashTable)['value'])[0]
        @(foreach ($id in $ServicePrincipalId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$id' and resourceId eq '$($resource['id'])'" -OutputType HashTable)['value']) |
                Where-Object { $_ } | ForEach-Object {
                    $scopes = @("$($_['scope'])" -split ' ' | Where-Object { $_ })
                    $remove = @($scopes | Where-Object { @($Permission) -contains '*' -or @($Permission) -contains $_ })
                    if ($remove.Count -gt 0) { [PSCustomObject]@{ GrantId = $_['id']; ConsentType = $_['consentType']; Scopes = $scopes; Remove = $remove } }
                }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($grant in $State) {
            $keep = @($grant.Scopes | Where-Object { $grant.Remove -notcontains $_ })
            if ($keep.Count -eq 0) { Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/oauth2PermissionGrants/$($grant.GrantId)" | Out-Null }
            else { Set-RemediationGraphObject -Uri "/v1.0/oauth2PermissionGrants/$($grant.GrantId)" -Body @{ scope = ($keep -join ' ') } }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
