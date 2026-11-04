<#
.SYNOPSIS
    Remediates EXO-AUDIT-002: Ensure 'AuditBypassEnabled' is not enabled on mailboxes
.DESCRIPTION
    Turns off audit bypass for every account that has it, so their mailbox actions are audited.

    Desired state: No mailbox audit bypass associations enabled
    Requires: Exchange Online (Connect-ExchangeOnline).

    Audit bypass is usually set for service accounts (backup, archiving) to reduce log volume.
    Turning it off increases audit volume for those accounts.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUDIT-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUDIT-002.ps1
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
    CheckId   = 'EXO-AUDIT-002'
    Target    = 'Mailbox audit bypass associations'
    Desired   = 'None enabled'
    GetState  = {
        @(Get-MailboxAuditBypassAssociation -ResultSize Unlimited -WarningAction SilentlyContinue | Where-Object { $_.AuditBypassEnabled -eq $true })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($association in $State) {
            Set-MailboxAuditBypassAssociation -Identity $association.Identity -AuditBypassEnabled $false
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
