<#
.SYNOPSIS
    Remediates ENTRA-CONSENT-004: Tenant-wide admin consent grants to third-party apps
.DESCRIPTION
    Revokes tenant-wide (all users) delegated permission grants for the applications you name.
    Use after reviewing which admin-consented apps no longer need access for everyone.

    Desired state: No AllPrincipals grants for -ServicePrincipalId
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DelegatedPermissionGrant.ReadWrite.All.

    Revoking a grant stops the app from acting on behalf of every user; users can be prompted
    for consent again if user consent is allowed. Each removed grant (client, resource, scopes) is
    returned in Before so it can be recreated.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ServicePrincipalId
    Object IDs of the enterprise applications (service principals) whose tenant-wide grants to revoke.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-004.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-004.ps1 -ServicePrincipalId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ServicePrincipalId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DelegatedPermissionGrant.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-CONSENT-004'
    Target    = 'Tenant-wide delegated grants for the listed apps'
    Desired   = 'Revoked'
    GetState  = {
        @(foreach ($sp in $ServicePrincipalId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$sp' and consentType eq 'AllPrincipals'" -OutputType HashTable)['value']) |
                Where-Object { $_ } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; ClientId = $_['clientId']; ResourceId = $_['resourceId']; Scope = $_['scope'] } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($grant in $State) {
            Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/oauth2PermissionGrants/$($grant.Id)" | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
