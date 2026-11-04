<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-013: Apps with expired credentials still present
.DESCRIPTION
    Removes expired client secrets and certificates from app registrations (all, or the ones you
    name). Expired credentials cannot be used, so nothing stops working.

    Desired state: No expired credentials
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    Only credentials whose end date has passed are removed.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
    Defaults to every app registration.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-013.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-013.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$ApplicationObjectId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Application.ReadWrite.All'

$now = (Get-Date).ToUniversalTime()

$step = @{
    CheckId   = 'ENTRA-ENTAPP-013'
    Target    = 'App registration credentials'
    Desired   = 'No expired credentials'
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {
            $app = $_
            $row = [PSCustomObject]@{ Id = $app['id']; DisplayName = $app['displayName']; Secrets = @($app['passwordCredentials'] | Where-Object { $_ -and $_['endDateTime'] -and [datetime]$_['endDateTime'] -lt $now } | ForEach-Object { "$($_['keyId'])" }); Certificates = @($app['keyCredentials'] | Where-Object { $_ -and $_['endDateTime'] -and [datetime]$_['endDateTime'] -lt $now } | ForEach-Object { "$($_['keyId'])" }) }
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
