<#
.SYNOPSIS
    Remediates COMPLIANCE-LABELS-002: Ensure Auto-Sensitivity Labeling Policies are Configured
.DESCRIPTION
    Creates an auto-labeling policy that applies a sensitivity label to content containing the
    sensitive information types you choose, across Exchange, SharePoint, and OneDrive. Created in
    simulation mode.

    Desired state: Enabled auto-labeling policy
    Requires: Security & Compliance PowerShell (Connect-IPPSSession).

    Requires Microsoft 365 E5 / E5 Compliance (or Information Protection P2).

    Triage bucket: Needs decision (Policy template (Purview)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER LabelName
    Existing sensitivity label to apply.
.PARAMETER SensitiveInformationType
    Sensitive information type names to detect, e.g. 'Credit Card Number',
    'U.S. Social Security Number (SSN)'. List them with Get-DlpSensitiveInformationType.
.PARAMETER PolicyName
    Name of the auto-labeling policy.
.PARAMETER Mode
    Defaults to simulation; switch to Enable after review.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-LABELS-002.ps1 -LabelName 'Confidential' -SensitiveInformationType 'Credit Card Number' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-LABELS-002.ps1 -LabelName 'Confidential' -SensitiveInformationType 'Credit Card Number'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$LabelName,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$SensitiveInformationType,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'M365-Assess auto-labeling',

    [Parameter()]
    [ValidateSet('TestWithoutNotifications', 'TestWithNotifications', 'Enable')]
    [string]$Mode = 'TestWithoutNotifications'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SecurityCompliance'

$sitList = @($SensitiveInformationType | ForEach-Object { @{ Name = $_ } })

$step = @{
    CheckId   = 'COMPLIANCE-LABELS-002'
    Target    = "Auto-labeling policy $PolicyName"
    Desired   = 'Exists and enabled'
    GetState  = {
        Get-AutoSensitivityLabelPolicy -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.Enabled -eq $true
    }
    SetState  = {
        param($State)
        if ($null -eq $State) {
            New-AutoSensitivityLabelPolicy -Name $PolicyName -ApplySensitivityLabel $LabelName -ExchangeLocation All -SharePointLocation All -OneDriveLocation All -Mode $Mode | Out-Null
            foreach ($workload in @('Exchange', 'SharePoint', 'OneDriveForBusiness')) {
                New-AutoSensitivityLabelRule -Name "$PolicyName $workload" -Policy $PolicyName -Workload $workload -ContentContainsSensitiveInformation $sitList | Out-Null
            }
        }
        else {
            Set-AutoSensitivityLabelPolicy -Identity $PolicyName -Enabled $true -Mode $Mode
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
