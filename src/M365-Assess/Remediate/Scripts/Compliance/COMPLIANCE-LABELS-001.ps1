<#
.SYNOPSIS
    Remediates COMPLIANCE-LABELS-001: Ensure Information Protection sensitivity label policies are published
.DESCRIPTION
    Publishes existing sensitivity labels to users with a label policy, creating any listed
    labels that do not exist yet (as plain labels with no protection settings).

    Desired state: A label policy publishes -LabelName
    Requires: Security & Compliance PowerShell (Connect-IPPSSession).

    Configure encryption, marking, and scope on the labels themselves in the Purview portal.
    Published labels can take up to 24 hours to appear in apps.

    Triage bucket: Needs decision (Policy template (Purview)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER LabelName
    Labels to publish, e.g. 'Public', 'General', 'Confidential'.
.PARAMETER PolicyName
    Name of the label policy.
.PARAMETER CreateMissingLabel
    Create labels from -LabelName that do not exist. Without it, missing labels fail the step.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-LABELS-001.ps1 -LabelName 'Public', 'General', 'Confidential' -CreateMissingLabel -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Compliance/COMPLIANCE-LABELS-001.ps1 -LabelName 'Public', 'General', 'Confidential' -CreateMissingLabel
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$LabelName,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'M365-Assess baseline labels',

    [Parameter()]
    [switch]$CreateMissingLabel
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SecurityCompliance'

$step1 = @{
    CheckId   = 'COMPLIANCE-LABELS-001'
    Target    = 'Sensitivity labels'
    Desired   = 'All of -LabelName exist'
    GetState  = {
        $existing = @(Get-Label | ForEach-Object { "$($_.Name)" })
        @($LabelName | Where-Object { $existing -notcontains $_ })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        if (-not $CreateMissingLabel.IsPresent) { throw "Labels not found: $($State -join ', '). Create them or pass -CreateMissingLabel." }
        foreach ($name in $State) { New-Label -Name $name -DisplayName $name -Tooltip $name | Out-Null }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'COMPLIANCE-LABELS-001'
    Target    = "Label policy $PolicyName"
    Desired   = 'Publishes the labels to all users'
    GetState  = {
        Get-LabelPolicy -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -ne $State -and @($LabelName | Where-Object { @($State.Labels) -notcontains $_ -and @($State.ScopedLabels) -notcontains $_ }).Count -eq 0
    }
    SetState  = {
        param($State)
        if ($null -eq $State) { New-LabelPolicy -Name $PolicyName -Labels $LabelName -ExchangeLocation All | Out-Null }
        else { Set-LabelPolicy -Identity $PolicyName -AddLabels $LabelName }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
