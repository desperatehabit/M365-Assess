<#
.SYNOPSIS
    Remediates DEFENDER-ANTISPAM-002: Ensure inbound anti-spam policies do not contain allowed domains
.DESCRIPTION
    Clears the allowed sender domains list on inbound anti-spam policies. Allowed domains skip
    spam filtering, which makes them a spoofing target.

    Desired state: AllowedSenderDomains empty on every inbound anti-spam policy
    Requires: Exchange Online (Connect-ExchangeOnline).

    Removed domains are returned in Before. Replace real needs with tenant allow/block list
    entries, which still get authentication checks.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ANTISPAM-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ANTISPAM-002.ps1
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
    CheckId   = 'DEFENDER-ANTISPAM-002'
    Target    = 'Inbound anti-spam policies with allowed sender domains'
    Desired   = 'None'
    GetState  = {
        @(Get-HostedContentFilterPolicy | Where-Object { @($_.AllowedSenderDomains | Where-Object { $_ }).Count -gt 0 } |
            Select-Object -Property Name, Identity, AllowedSenderDomains)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($policy in $State) {
            Set-HostedContentFilterPolicy -Identity $policy.Identity -AllowedSenderDomains @{}
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
