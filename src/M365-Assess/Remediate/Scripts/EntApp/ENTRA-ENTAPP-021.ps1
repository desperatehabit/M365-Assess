<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-021: Multi-tenant app registrations (AzureADMultipleOrgs)
.DESCRIPTION
    Changes the app registrations you name from multi-tenant to single-tenant (AzureADMyOrg).

    Desired state: signInAudience = AzureADMyOrg on the listed apps
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    Users from other tenants can no longer sign in to these apps. Apps that also allow personal
    Microsoft accounts may need their API permissions or token version adjusted first.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-021.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-021.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ApplicationObjectId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Application.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-ENTAPP-021'
    Target    = 'Multi-tenant app registrations'
    Desired   = 'Single-tenant'
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object { $_['signInAudience'] -ne 'AzureADMyOrg' } |
            ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; SignInAudience = $_['signInAudience'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($app in $State) { Set-RemediationGraphObject -Uri "/v1.0/applications/$($app.Id)" -Body @{ signInAudience = 'AzureADMyOrg' } }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
