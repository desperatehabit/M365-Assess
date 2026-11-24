<#
.SYNOPSIS
    Remediates ENTRA-PASSWORD-001: Ensure the 'Password expiration policy' is set to 'Set passwords to never expire'
.DESCRIPTION
    Sets passwords to never expire on every managed (cloud-authenticated) verified domain.

    Desired state: passwordValidityPeriodInDays = 2147483647 on managed domains
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Domain.ReadWrite.All.

    Only appropriate with MFA enforced. Federated domains are skipped; their password policy
    lives in the on-premises directory.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PASSWORD-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PASSWORD-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Domain.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-PASSWORD-001'
    Target    = 'Managed domains with password expiration'
    Desired   = 'Never expire'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/domains' -OutputType HashTable)['value']) | Where-Object {
            $null -ne $_ -and $_['isVerified'] -eq $true -and $_['authenticationType'] -eq 'Managed' -and $_['passwordValidityPeriodInDays'] -ne 2147483647
        } | ForEach-Object { $_['id'] })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($domain in $State) {
            Set-RemediationGraphObject -Uri "/v1.0/domains/$domain" -Body @{ passwordValidityPeriodInDays = 2147483647 }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
