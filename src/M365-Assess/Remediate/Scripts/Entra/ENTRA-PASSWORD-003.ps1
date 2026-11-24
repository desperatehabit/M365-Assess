<#
.SYNOPSIS
    Remediates ENTRA-PASSWORD-003: Smart Lockout Threshold
.DESCRIPTION
    Sets the smart lockout threshold to 10 failed sign-ins or fewer.

    Desired state: LockoutThreshold <= -Threshold
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Directory.ReadWrite.All.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Threshold
    Failed attempts before lockout (1-10). An existing lower threshold is kept.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PASSWORD-003.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PASSWORD-003.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateRange(1, 10)]
    [int]$Threshold = 10
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Directory.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-PASSWORD-003'
    Target    = 'Password rule settings (smart lockout)'
    Desired   = "Threshold $Threshold or lower"
    GetState  = {
        Get-RemediationDirectorySetting -TemplateId '5cf42378-d67d-4f36-ba46-e8b86229381d'
    }
    TestState = {
        param($State)
        $null -ne $State -and $null -ne $State['LockoutThreshold'] -and [int]$State['LockoutThreshold'] -le $Threshold
    }
    SetState  = {
        param($State)
        Set-RemediationDirectorySetting -TemplateId '5cf42378-d67d-4f36-ba46-e8b86229381d' -Values @{ LockoutThreshold = "$Threshold" }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
