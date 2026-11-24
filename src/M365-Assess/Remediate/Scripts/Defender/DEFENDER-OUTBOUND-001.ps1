<#
.SYNOPSIS
    Remediates DEFENDER-OUTBOUND-001: Ensure outbound anti-spam message limits are in place
.DESCRIPTION
    Hardens the default outbound anti-spam policy: automatic forwarding off, and a copy of
    suspicious outbound mail plus outbound-spam notifications sent to the address you choose.

    Desired state: AutoForwardingMode Off; BccSuspiciousOutboundMail and NotifyOutboundSpam on
    Requires: Exchange Online (Connect-ExchangeOnline).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyIdentity
    Policy to change. Defaults to the built-in default policy ('Default').
.PARAMETER NotifyAddress
    Mailbox(es) that receive the BCC copies and outbound spam notifications.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-OUTBOUND-001.ps1 -NotifyAddress 'secops@contoso.com' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-OUTBOUND-001.ps1 -NotifyAddress 'secops@contoso.com'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyIdentity = 'Default',

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$NotifyAddress
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step = @{
    CheckId   = 'DEFENDER-OUTBOUND-001'
    Target    = "Outbound spam filter policy $PolicyIdentity"
    Desired   = 'AutoForwardingMode = ''Off'', BccSuspiciousOutboundMail = $true, BccSuspiciousOutboundAdditionalRecipients = $NotifyAddress, NotifyOutboundSpam = $true, NotifyOutboundSpamRecipients = $NotifyAddress'
    GetState  = {
        Get-HostedOutboundSpamFilterPolicy -Identity $PolicyIdentity
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AutoForwardingMode = 'Off'
            BccSuspiciousOutboundMail = $true
            BccSuspiciousOutboundAdditionalRecipients = $NotifyAddress
            NotifyOutboundSpam = $true
            NotifyOutboundSpamRecipients = $NotifyAddress
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AutoForwardingMode = 'Off'
            BccSuspiciousOutboundMail = $true
            BccSuspiciousOutboundAdditionalRecipients = $NotifyAddress
            NotifyOutboundSpam = $true
            NotifyOutboundSpamRecipients = $NotifyAddress
        }
        Set-HostedOutboundSpamFilterPolicy -Identity $PolicyIdentity @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
