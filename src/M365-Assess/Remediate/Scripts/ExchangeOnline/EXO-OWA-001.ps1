<#
.SYNOPSIS
    Remediates EXO-OWA-001: Ensure additional storage providers are restricted in Outlook on the web
.DESCRIPTION
    Turns off additional storage providers (Dropbox, Box, and similar) in every Outlook on the web
    mailbox policy that allows them.

    Desired state: AdditionalStorageProvidersAvailable = False on every OWA mailbox policy
    Requires: Exchange Online (Connect-ExchangeOnline).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-OWA-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-OWA-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step = @{
    CheckId   = 'EXO-OWA-001'
    Target    = 'Outlook on the web mailbox policies'
    Desired   = 'No policy allows additional storage providers'
    GetState  = {
        @(Get-OwaMailboxPolicy -WarningAction SilentlyContinue | Where-Object { $_.AdditionalStorageProvidersAvailable -eq $true } | Select-Object -Property Name, Identity, AdditionalStorageProvidersAvailable)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($policy in $State) {
            Set-OwaMailboxPolicy -Identity $policy.Identity -AdditionalStorageProvidersAvailable $false
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
