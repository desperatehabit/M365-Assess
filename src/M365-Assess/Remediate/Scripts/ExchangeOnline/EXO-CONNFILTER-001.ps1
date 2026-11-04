<#
.SYNOPSIS
    Remediates EXO-CONNFILTER-001: Ensure the connection filter IP allow list is not used
.DESCRIPTION
    Empties the connection filter IP allow list. Allow-listed IPs skip spam filtering entirely.

    Desired state: IPAllowList empty
    Requires: Exchange Online (Connect-ExchangeOnline).

    The removed entries are returned in Before so they can be restored with
    Set-HostedConnectionFilterPolicy -IPAllowList. Replace legitimate needs with a
    transport rule or an inbound connector scoped to those IPs before running.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyIdentity
    Policy to harden. Defaults to the built-in default policy ('Default').
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-CONNFILTER-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-CONNFILTER-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyIdentity = 'Default'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step = @{
    CheckId   = 'EXO-CONNFILTER-001'
    Target    = "Connection filter policy $PolicyIdentity IP allow list"
    Desired   = 'Empty'
    GetState  = {
        Get-HostedConnectionFilterPolicy -Identity $PolicyIdentity
    }
    TestState = {
        param($State)
        @($State.IPAllowList | Where-Object { $_ }).Count -eq 0
    }
    SetState  = {
        param($State)
        Set-HostedConnectionFilterPolicy -Identity $PolicyIdentity -IPAllowList @{}
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
