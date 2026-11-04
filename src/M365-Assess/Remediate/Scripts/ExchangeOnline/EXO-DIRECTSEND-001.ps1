<#
.SYNOPSIS
    Remediates EXO-DIRECTSEND-001: Ensure Direct Send is not allowed for unauthorized relay
.DESCRIPTION
    Closes unauthenticated relay through inbound connectors that are enabled but neither require
    TLS nor restrict senders to IP addresses. Optionally also rejects Direct Send org-wide.

    Desired state: No enabled inbound connector without TLS or IP restriction
    Requires: Exchange Online (Connect-ExchangeOnline).

    Scanners and apps that send through Direct Send or an open connector stop delivering.
    Move them to SMTP AUTH or a certificate- or IP-scoped connector first.

    Triage bucket: Needs decision (User-impacting setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Action
    Disable: turn the open connectors off. RequireTls: keep them on but require TLS.
.PARAMETER RejectDirectSend
    Also set RejectDirectSend on the organization, so unauthenticated mail sent to your
    accepted domains from outside a connector is rejected.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-DIRECTSEND-001.ps1 -Action RequireTls -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-DIRECTSEND-001.ps1 -Action RequireTls
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Disable', 'RequireTls')]
    [string]$Action,

    [Parameter()]
    [switch]$RejectDirectSend
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step1 = @{
    CheckId   = 'EXO-DIRECTSEND-001'
    Target    = 'Inbound connectors without TLS or IP restriction'
    Desired   = 'None'
    GetState  = {
        @(Get-InboundConnector | Where-Object {
            $_.Enabled -eq $true -and $_.RequireTls -eq $false -and $_.RestrictDomainsToIPAddresses -eq $false
        } | Select-Object -Property Name, Identity, Enabled, RequireTls, RestrictDomainsToIPAddresses)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($connector in $State) {
            if ($Action -eq 'Disable') {
                Set-InboundConnector -Identity $connector.Identity -Enabled $false
            }
            else {
                Set-InboundConnector -Identity $connector.Identity -RequireTls $true
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'EXO-DIRECTSEND-001'
    Target    = 'Organization RejectDirectSend'
    Desired   = 'True when -RejectDirectSend is set'
    GetState  = {
        Get-OrganizationConfig | Select-Object -Property RejectDirectSend
    }
    TestState = {
        param($State)
        -not $RejectDirectSend.IsPresent -or $State.RejectDirectSend -eq $true
    }
    SetState  = {
        param($State)
        Set-OrganizationConfig -RejectDirectSend $true
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
