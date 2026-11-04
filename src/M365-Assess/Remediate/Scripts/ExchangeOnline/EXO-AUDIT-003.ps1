<#
.SYNOPSIS
    Remediates EXO-AUDIT-003: Ensure mailbox audit actions are configured
.DESCRIPTION
    Turns on mailbox auditing (AuditEnabled) for every user and shared mailbox that has it off.

    Desired state: AuditEnabled = True on all user and shared mailboxes
    Requires: Exchange Online (Connect-ExchangeOnline).

    Default audit actions are applied by Exchange Online; this script does not change the
    per-mailbox audit action lists.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUDIT-003.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUDIT-003.ps1
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
    CheckId   = 'EXO-AUDIT-003'
    Target    = 'Mailbox auditing (user and shared mailboxes)'
    Desired   = 'All enabled'
    GetState  = {
        @(Get-Mailbox -ResultSize Unlimited -RecipientTypeDetails UserMailbox, SharedMailbox |
            Where-Object { $_.AuditEnabled -ne $true } |
            Select-Object -Property UserPrincipalName, Identity, AuditEnabled)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($mailbox in $State) {
            Set-Mailbox -Identity $mailbox.Identity -AuditEnabled $true
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
