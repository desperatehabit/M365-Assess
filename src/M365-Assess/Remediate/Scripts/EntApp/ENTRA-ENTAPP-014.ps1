<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-014: Apps with both secret and certificate credentials (dual credential types)
.DESCRIPTION
    Removes client secrets from the app registrations you name that also have a certificate, leaving
    certificate authentication only.

    Desired state: Certificate only
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    Confirm the app (and every deployment of it) authenticates with the certificate before running.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-014.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-014.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001'
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
    CheckId   = 'ENTRA-ENTAPP-014'
    Target    = 'App registration credentials'
    Desired   = 'Certificate only'
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {
            $app = $_
            $row = [PSCustomObject]@{ Id = $app['id']; DisplayName = $app['displayName']; Secrets = @($app['passwordCredentials'] | Where-Object { $_ } | ForEach-Object { "$($_['keyId'])" }); Certificates = @() }
            if ($row.Secrets.Count -gt 0 -and @($app['keyCredentials'] | Where-Object { $_ }).Count -gt 0) { $row }
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
