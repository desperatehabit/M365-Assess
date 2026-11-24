<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-016: Tier 0 permission apps with owners assigned (owner can impersonate)
.DESCRIPTION
    Removes owners from Tier-0 permission apps you name (owners can add credentials and impersonate
    the app).

    Desired state: No owners on the listed apps (except -KeepOwnerId)
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    Both the app registration owners and the enterprise application (service principal) owners
    are removed. Application Administrators can still manage the app.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
.PARAMETER KeepOwnerId
    Owners to keep (for example a dedicated, PIM-protected app-admin account).
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-016.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-016.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ApplicationObjectId,

    [Parameter()]
    [string[]]$KeepOwnerId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Application.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-ENTAPP-016'
    Target    = 'Owners of the listed apps'
    Desired   = 'Removed'
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {
            $app = $_
            $sp = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/servicePrincipals?`$filter=appId eq '$($app['appId'])'&`$select=id" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
            $targets = @(@{ Kind = 'applications'; Id = $app['id'] })
            if ($sp) { $targets += @{ Kind = 'servicePrincipals'; Id = $sp['id'] } }
            foreach ($t in $targets) {
                @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/$($t.Kind)/$($t.Id)/owners?`$select=id,userPrincipalName" -OutputType HashTable)['value']) |
                    Where-Object { $null -ne $_ -and @($KeepOwnerId) -notcontains $_['id'] } |
                    ForEach-Object { [PSCustomObject]@{ Kind = $t.Kind; ObjectId = $t.Id; App = $app['displayName']; OwnerId = $_['id']; Owner = $_['userPrincipalName'] } }
            }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($owner in $State) { Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/$($owner.Kind)/$($owner.ObjectId)/owners/$($owner.OwnerId)/`$ref" | Out-Null }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
