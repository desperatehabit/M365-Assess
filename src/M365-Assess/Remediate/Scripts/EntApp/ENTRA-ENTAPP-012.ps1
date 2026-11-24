<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-012: Apps using client secrets instead of certificates
.DESCRIPTION
    Moves the app registrations you name from client secrets to a certificate: uploads the
    certificate's public key, then (with -RemoveSecrets) removes the secrets.

    Desired state: Certificate credential present; secrets removed with -RemoveSecrets
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    The private key never leaves the machine running the app; only the public certificate is
    uploaded.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
.PARAMETER CertificatePath
    Path to the public certificate (.cer, DER or Base-64) the app will authenticate with.
.PARAMETER RemoveSecrets
    Remove the client secrets after adding the certificate. Run once without it, switch the app
    over, then run again with it.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-012.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001' -CertificatePath '.\app.cer' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-012.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001' -CertificatePath '.\app.cer'
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

    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$CertificatePath,

    [Parameter()]
    [switch]$RemoveSecrets
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Application.ReadWrite.All'

$step1 = @{
    CheckId   = 'ENTRA-ENTAPP-012'
    Target    = 'Certificate credential on the listed apps'
    Desired   = 'Certificate from -CertificatePath present'
    GetState  = {
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CertificatePath).Path)
        $thumb = $cert.Thumbprint
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object {
            @($_['keyCredentials'] | Where-Object { $_ -and "$($_['customKeyIdentifier'])" -eq $thumb }).Count -eq 0
        } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Keys = @($_['keyCredentials'] | Where-Object { $_ }) } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CertificatePath).Path)
        foreach ($app in $State) {
            $newKey = @{ type = 'AsymmetricX509Cert'; usage = 'Verify'; key = [Convert]::ToBase64String($cert.RawData); displayName = "CN=$($cert.GetNameInfo('SimpleName', $false))" }
            Set-RemediationGraphObject -Uri "/v1.0/applications/$($app.Id)" -Body @{ keyCredentials = @($app.Keys + $newKey) }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'ENTRA-ENTAPP-012'
    Target    = 'Client secrets on the listed apps'
    Desired   = 'Removed when -RemoveSecrets is set'
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | Where-Object { @($_['passwordCredentials'] | Where-Object { $_ }).Count -gt 0 } |
            ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Secrets = @($_['passwordCredentials'] | ForEach-Object { "$($_['keyId'])" }) } })
    }
    TestState = {
        param($State)
        -not $RemoveSecrets.IsPresent -or $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($app in $State) { Remove-RemediationAppCredential -ObjectId $app.Id -SecretKeyId $app.Secrets }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
