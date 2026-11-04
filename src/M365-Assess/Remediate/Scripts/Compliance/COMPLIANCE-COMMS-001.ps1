<#
.SYNOPSIS
    Remediates COMPLIANCE-COMMS-001: Ensure Communication Compliance Policies are Enabled
.DESCRIPTION
    Creates a communication compliance policy that reviews Exchange and Teams messages from the
    monitored users/groups for offensive or harassing language, with the reviewers you name.

    Desired state: Enabled communication compliance policy
    Requires: Security & Compliance PowerShell (Connect-IPPSSession).

    Uses the SupervisoryReviewPolicyV2 / SupervisoryReviewRule cmdlets that back Communication
    compliance. Requires E5 / E5 Compliance or Insider Risk add-on. Communication compliance has
    privacy and works-council implications; agree scope with HR and legal first.

    Triage bucket: Needs decision (Policy template (Purview)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Reviewer
    Reviewers (email addresses). They also need the Communication Compliance role.
.PARAMETER MonitoredGroup
    Distribution or Microsoft 365 group addresses whose members are monitored.
.PARAMETER PolicyName
    Policy name.
.PARAMETER SamplingRate
    Percentage of matching messages sent for review.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-COMMS-001.ps1 -Reviewer 'hr-review@contoso.com' -MonitoredGroup 'allstaff@contoso.com' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-COMMS-001.ps1 -Reviewer 'hr-review@contoso.com' -MonitoredGroup 'allstaff@contoso.com'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Reviewer,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$MonitoredGroup,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'M365-Assess communication compliance',

    [Parameter()]
    [ValidateRange(1, 100)]
    [int]$SamplingRate = 100
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SecurityCompliance'

$step = @{
    CheckId   = 'COMPLIANCE-COMMS-001'
    Target    = "Communication compliance policy $PolicyName"
    Desired   = 'Exists and enabled'
    GetState  = {
        Get-SupervisoryReviewPolicyV2 -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.Enabled -ne $false
    }
    SetState  = {
        param($State)
        if ($null -eq $State) {
            New-SupervisoryReviewPolicyV2 -Name $PolicyName -Reviewers $Reviewer | Out-Null
            $condition = '(' + (@($MonitoredGroup | ForEach-Object { "Reviewee:$_" }) -join ' -OR ') + ')'
            New-SupervisoryReviewRule -Name "$PolicyName rule" -Policy $PolicyName -SamplingRate $SamplingRate -Condition $condition -ContentSources 'Exchange', 'Teams' | Out-Null
        }
        else {
            Set-SupervisoryReviewPolicyV2 -Identity $PolicyName -Enabled $true
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
