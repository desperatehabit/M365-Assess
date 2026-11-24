<#
.SYNOPSIS
    Remediates COMPLIANCE-ALERTPOLICY-001: Security Alert Policies Configuration
.DESCRIPTION
    Re-enables built-in (system) alert policies of high severity that have been turned off, such
    as suspicious activity, malware, and elevation of privilege alerts.

    Desired state: No disabled high-severity system alert policies
    Requires: Security & Compliance PowerShell (Connect-IPPSSession).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Severity
    Severities to re-enable. Defaults to High.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-ALERTPOLICY-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-ALERTPOLICY-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateSet('High', 'Medium', 'Low', 'Informational')]
    [string[]]$Severity = 'High'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SecurityCompliance'

$step = @{
    CheckId   = 'COMPLIANCE-ALERTPOLICY-001'
    Target    = 'Disabled system alert policies'
    Desired   = 'All enabled'
    GetState  = {
        @(Get-ProtectionAlert | Where-Object { $_.Disabled -eq $true -and $_.IsSystemRule -eq $true -and @($Severity) -contains "$($_.Severity)" } |
            Select-Object -Property Name, Identity, Severity, Disabled)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($alert in $State) {
            Set-ProtectionAlert -Identity $alert.Identity -Disabled $false
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
