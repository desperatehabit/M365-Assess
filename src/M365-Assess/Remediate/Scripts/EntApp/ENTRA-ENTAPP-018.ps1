<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-018: Credentialed apps with no owners (orphaned)
.DESCRIPTION
    Assigns an owner to app registrations that have credentials but no owners, so someone is
    accountable for rotating credentials and reviewing permissions.

    Desired state: Every credentialed app has an owner
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    Do not use this for Tier-0 or role-holding apps (see ENTRA-ENTAPP-016/017): an owner of
    those can escalate privilege.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER OwnerId
    Object ID of the user to make owner.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
    Defaults to every app registration.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-018.ps1 -OwnerId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-018.ps1 -OwnerId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OwnerId,

    [Parameter()]
    [string[]]$ApplicationObjectId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Application.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-ENTAPP-018'
    Target    = 'Credentialed apps with no owners'
    Desired   = "Owner $OwnerId assigned"
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object {
            (@($_['passwordCredentials'] | Where-Object { $_ }).Count + @($_['keyCredentials'] | Where-Object { $_ }).Count) -gt 0
        } | Where-Object {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/applications/$($_['id'])/owners?`$select=id" -OutputType HashTable)['value'] | Where-Object { $_ }).Count -eq 0
        } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($app in $State) {
            Set-RemediationGraphObject -Uri "/v1.0/applications/$($app.Id)/owners/`$ref" -Method POST -Body @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$OwnerId" }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
