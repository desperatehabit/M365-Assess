<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-001: Enabled apps with client credentials (secrets or certificates)
.DESCRIPTION
    Removes all client secrets and certificates from the app registrations you name (apps that no
    longer need to authenticate as themselves).

    Desired state: Removed
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    Anything authenticating with the removed credentials stops working immediately. Each
    removed credential (keyId, name, expiry) is returned in Before.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-001.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-001.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001'
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
    CheckId   = 'ENTRA-ENTAPP-001'
    Target    = 'App registration credentials'
    Desired   = 'Removed'
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {
            $app = $_
            $row = [PSCustomObject]@{ Id = $app['id']; DisplayName = $app['displayName']; Secrets = @($app['passwordCredentials'] | Where-Object { $_ } | ForEach-Object { "$($_['keyId'])" }); Certificates = @($app['keyCredentials'] | Where-Object { $_ } | ForEach-Object { "$($_['keyId'])" }) }
            if ($row.Secrets.Count + $row.Certificates.Count -gt 0) { $row }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($finding in $State) {
            Remove-RemediationAppCredential -ObjectId $finding.Id -SecretKeyId @($finding.Secrets) -CertificateKeyId @($finding.Certificates)
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
