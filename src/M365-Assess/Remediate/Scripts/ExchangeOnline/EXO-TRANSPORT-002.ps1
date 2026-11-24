<#
.SYNOPSIS
    Remediates EXO-TRANSPORT-002: Transport Rule Configuration for External Forwarding
.DESCRIPTION
    Creates (or updates) a mail flow rule that rejects automatic forwarding of internal mail to
    external recipients. Created in Audit mode by default so you can review matches first.

    Desired state: Auto-forward block rule exists with the chosen -Mode
    Requires: Exchange Online (Connect-ExchangeOnline).

    Pair with EXO-FORWARD-001, which blocks forwarding in the outbound spam policy and remote
    domain. Review message trace for rule matches before switching -Mode to Enforce.

    Triage bucket: Needs decision (Policy template).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RuleName
    Name of the rule to create or update.
.PARAMETER Mode
    Audit (default) logs matches without blocking. Enforce blocks.
.PARAMETER ExceptRecipientDomain
    External domains auto-forwarding is still allowed to.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-TRANSPORT-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-TRANSPORT-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$RuleName = 'Block external auto-forwarding',

    [Parameter()]
    [ValidateSet('Audit', 'AuditAndNotify', 'Enforce')]
    [string]$Mode = 'Audit',

    [Parameter()]
    [string[]]$ExceptRecipientDomain
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$ruleSettings = @{
    FromScope               = 'InOrganization'
    SentToScope             = 'NotInOrganization'
    MessageTypeMatches      = 'AutoForward'
    RejectMessageReasonText = 'Automatic forwarding to external recipients is not allowed.'
    Mode                    = $Mode
}
if (@($ExceptRecipientDomain | Where-Object { $_ }).Count -gt 0) { $ruleSettings['ExceptIfRecipientDomainIs'] = @($ExceptRecipientDomain) }

$step = @{
    CheckId   = 'EXO-TRANSPORT-002'
    Target    = "Mail flow rule $RuleName"
    Desired   = "Rejects external auto-forwarding (Mode $Mode)"
    GetState  = {
        Get-TransportRule -Identity $RuleName -ErrorAction SilentlyContinue | Select-Object -Property Name, Identity, State, Mode, FromScope, SentToScope, MessageTypeMatches, RejectMessageReasonText, ExceptIfRecipientDomainIs
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected @{ FromScope = 'InOrganization'; SentToScope = 'NotInOrganization'; MessageTypeMatches = 'AutoForward'; Mode = $Mode })
    }
    SetState  = {
        param($State)
        if ($null -eq $State) {
            New-TransportRule -Name $RuleName @ruleSettings | Out-Null
        }
        else {
            Set-TransportRule -Identity $RuleName @ruleSettings
            if ($State.State -ne 'Enabled') { Enable-TransportRule -Identity $RuleName -Confirm:$false }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
