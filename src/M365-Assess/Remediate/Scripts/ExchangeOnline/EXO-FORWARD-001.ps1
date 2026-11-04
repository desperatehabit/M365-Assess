<#
.SYNOPSIS
    Remediates EXO-FORWARD-001: Ensure all forms of mail forwarding are blocked and/or disabled
.DESCRIPTION
    Blocks automatic forwarding to external recipients in both places Exchange Online enforces it:
    the Default remote domain and the default outbound anti-spam policy.

    Desired state: Remote domain Default AutoForwardEnabled = False; outbound spam policy AutoForwardingMode = Off
    Requires: Exchange Online (Connect-ExchangeOnline).

    Mailboxes with an approved business need for external forwarding need a separate outbound
    spam policy scoped to them before you run this.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-FORWARD-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-FORWARD-001.ps1
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

$step1 = @{
    CheckId   = 'EXO-FORWARD-001'
    Target    = 'Remote domain Default'
    Desired   = 'AutoForwardEnabled = $false'
    GetState  = {
        Get-RemoteDomain -Identity Default
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AutoForwardEnabled = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AutoForwardEnabled = $false
        }
        Set-RemoteDomain -Identity Default @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'EXO-FORWARD-001'
    Target    = 'Outbound spam filter policy Default'
    Desired   = 'AutoForwardingMode = ''Off'''
    GetState  = {
        Get-HostedOutboundSpamFilterPolicy -Identity Default
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AutoForwardingMode = 'Off'
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AutoForwardingMode = 'Off'
        }
        Set-HostedOutboundSpamFilterPolicy -Identity Default @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
