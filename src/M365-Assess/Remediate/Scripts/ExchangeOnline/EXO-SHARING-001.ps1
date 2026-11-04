<#
.SYNOPSIS
    Remediates EXO-SHARING-001: Ensure 'External sharing' of calendars is not available
.DESCRIPTION
    Removes the wildcard (*) entry from sharing policies so calendars cannot be shared with
    any external domain. Other domain entries are kept; a policy left with no entries is disabled.

    Desired state: No sharing policy contains a * domain entry
    Requires: Exchange Online (Connect-ExchangeOnline).

    Users lose the ability to share calendars with arbitrary external domains. Add specific
    partner domains to the policy afterwards if needed.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-SHARING-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-SHARING-001.ps1
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
    CheckId   = 'EXO-SHARING-001'
    Target    = 'Sharing policies'
    Desired   = 'No wildcard domain entries'
    GetState  = {
        @(Get-SharingPolicy | Where-Object { (@($_.Domains) -join ';') -match '\*' } | Select-Object -Property Name, Identity, Domains, Enabled)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($policy in $State) {
            $remaining = @($policy.Domains | Where-Object { "$_" -notmatch '^\*' })
            if ($remaining.Count -gt 0) {
                Set-SharingPolicy -Identity $policy.Identity -Domains $remaining
            }
            else {
                Set-SharingPolicy -Identity $policy.Identity -Domains $null -Enabled $false
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
