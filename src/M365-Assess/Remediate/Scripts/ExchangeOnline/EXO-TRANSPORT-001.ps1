<#
.SYNOPSIS
    Remediates EXO-TRANSPORT-001: Ensure mail transport rules do not whitelist specific domains
.DESCRIPTION
    Deals with mail flow rules that set SCL -1 (bypass spam filtering) for named sender domains.

    Desired state: No rule sets SCL -1 for sender domains
    Requires: Exchange Online (Connect-ExchangeOnline).

    Before is returned with each rule's name, sender domains, and priority so the rules can be
    recreated. Replace legitimate allow-listing with tenant allow/block list entries.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Action
    Remove: delete the rules (the check then passes). Disable: turn them off but keep them;
    the check still lists disabled rules, so it will keep reporting them.
.PARAMETER RuleName
    Limit the change to these rule names. Defaults to every matching rule.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-TRANSPORT-001.ps1 -Action Disable -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-TRANSPORT-001.ps1 -Action Disable
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Remove', 'Disable')]
    [string]$Action,

    [Parameter()]
    [string[]]$RuleName
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step = @{
    CheckId   = 'EXO-TRANSPORT-001'
    Target    = 'Mail flow rules that bypass spam filtering by sender domain'
    Desired   = 'None (per -Action)'
    GetState  = {
        @(Get-TransportRule | Where-Object {
            $_.SetSCL -eq -1 -and $_.SenderDomainIs -and
            (@($RuleName | Where-Object { $_ }).Count -eq 0 -or @($RuleName) -contains $_.Name)
        } | Select-Object -Property Name, Identity, State, Priority, SenderDomainIs, SetSCL)
    }
    TestState = {
        param($State)
        if ($Action -eq 'Disable') { @($State | Where-Object { $_.State -eq 'Enabled' }).Count -eq 0 } else { $null -eq $State -or @($State).Count -eq 0 }
    }
    SetState  = {
        param($State)
        foreach ($rule in $State) {
            if ($Action -eq 'Remove') { Remove-TransportRule -Identity $rule.Identity -Confirm:$false }
            elseif ($rule.State -eq 'Enabled') { Disable-TransportRule -Identity $rule.Identity -Confirm:$false }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
