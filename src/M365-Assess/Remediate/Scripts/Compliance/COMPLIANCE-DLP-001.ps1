<#
.SYNOPSIS
    Remediates COMPLIANCE-DLP-001: Ensure DLP policies are enabled
.DESCRIPTION
    Creates a DLP policy across Exchange, SharePoint, OneDrive, and Teams with a rule for the
    sensitive information types you choose.

    Desired state: Enabled DLP policy covering Exchange, SharePoint, OneDrive, Teams
    Requires: Security & Compliance PowerShell (Connect-IPPSSession).

    Created in simulation mode by default. Review matches in Activity explorer before
    switching -Mode to Enable.

    Triage bucket: Needs decision (Policy template (Purview)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyName
    Name of the DLP policy to create or update.
.PARAMETER SensitiveInformationType
    Sensitive information type names to detect, e.g. 'Credit Card Number',
    'U.S. Social Security Number (SSN)'. List them with Get-DlpSensitiveInformationType.
.PARAMETER Mode
    Policy mode. Defaults to simulation without notifications; switch to Enable after review.
.PARAMETER BlockAccess
    Block access to matching content (otherwise matches are only reported).
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-DLP-001.ps1 -SensitiveInformationType 'Credit Card Number' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-DLP-001.ps1 -SensitiveInformationType 'Credit Card Number'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'M365-Assess baseline DLP',

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$SensitiveInformationType,

    [Parameter()]
    [ValidateSet('TestWithoutNotifications', 'TestWithNotifications', 'Enable')]
    [string]$Mode = 'TestWithoutNotifications',

    [Parameter()]
    [switch]$BlockAccess
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SecurityCompliance'

$locations = @{
    ExchangeLocation = 'All'
    SharePointLocation = 'All'
    OneDriveLocation = 'All'
    TeamsLocation = 'All'
}
$sitList = @($SensitiveInformationType | ForEach-Object { @{ Name = $_ } })

$step1 = @{
    CheckId   = 'COMPLIANCE-DLP-001'
    Target    = "DLP policy $PolicyName"
    Desired   = 'Exists, enabled, covers the locations'
    GetState  = {
        Get-DlpCompliancePolicy -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.Enabled -eq $true -and $true
    }
    SetState  = {
        param($State)
        if ($null -eq $State) {
            New-DlpCompliancePolicy -Name $PolicyName -Mode $Mode @locations | Out-Null
        }
        else {
            $add = @{}
            foreach ($key in $locations.Keys) { $add["Add$key"] = 'All' }
            Set-DlpCompliancePolicy -Identity $PolicyName -Mode $Mode -Enabled $true @add
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'COMPLIANCE-DLP-001'
    Target    = "DLP rule $PolicyName rule"
    Desired   = 'Rule detecting the chosen sensitive information types'
    GetState  = {
        Get-DlpComplianceRule -Policy $PolicyName -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State
    }
    SetState  = {
        param($State)
        New-DlpComplianceRule -Name "$PolicyName rule" -Policy $PolicyName -ContentContainsSensitiveInformation $sitList -BlockAccess $BlockAccess.IsPresent | Out-Null
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
