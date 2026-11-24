<#
.SYNOPSIS
    Remediates EXO-AUDIT-001: Ensure 'AuditDisabled' organizationally is set to 'False'
.DESCRIPTION
    Turns on organization-wide mailbox auditing (AuditDisabled = False).

    Desired state: AuditDisabled = $false
    Requires: Exchange Online (Connect-ExchangeOnline).

    This is a pre-condition for the unified audit log but does not turn it on; see
    COMPLIANCE-AUDIT-001 for that.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUDIT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUDIT-001.ps1
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
    CheckId   = 'EXO-AUDIT-001'
    Target    = 'Exchange organization config'
    Desired   = 'AuditDisabled = $false'
    GetState  = {
        Get-OrganizationConfig
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AuditDisabled = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AuditDisabled = $false
        }
        Set-OrganizationConfig @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
