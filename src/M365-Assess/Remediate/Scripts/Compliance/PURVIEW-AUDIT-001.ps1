<#
.SYNOPSIS
    Remediates PURVIEW-AUDIT-001: Unified Audit Logging Enabled
.DESCRIPTION
    Turns on unified audit log ingestion (audit log search).

    Desired state: UnifiedAuditLogIngestionEnabled = $true
    Requires: Exchange Online (Connect-ExchangeOnline).

    Run from Exchange Online PowerShell. It can take up to 60 minutes for search to work after
    turning this on.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/PURVIEW-AUDIT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/PURVIEW-AUDIT-001.ps1
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
    CheckId   = 'PURVIEW-AUDIT-001'
    Target    = 'Unified audit log ingestion'
    Desired   = 'UnifiedAuditLogIngestionEnabled = $true'
    GetState  = {
        Get-AdminAuditLogConfig
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            UnifiedAuditLogIngestionEnabled = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            UnifiedAuditLogIngestionEnabled = $true
        }
        Set-AdminAuditLogConfig @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
