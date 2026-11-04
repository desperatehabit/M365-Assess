<#
.SYNOPSIS
    Remediates PURVIEW-RETENTION-003: Ensure Teams is covered by a retention policy
.DESCRIPTION
    Creates (or extends) a retention policy for Teams channel messages and chats. Teams
    locations need their own policy; they cannot be combined with Exchange or SharePoint.

    Desired state: Enabled retention policy covering TeamsChannelLocation, TeamsChatLocation
    Requires: Security & Compliance PowerShell (Connect-IPPSSession).

    KeepAndDelete and Delete permanently remove content at the end of the period. Retention
    periods are a legal and records-management decision; agree them before running.

    Triage bucket: Needs decision (Policy template (Purview)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyName
    Name of the retention policy to create or update.
.PARAMETER RetentionDays
    How long to retain content, in days (e.g. 2555 for 7 years).
.PARAMETER RetentionAction
    Keep (default) retains content for the period; KeepAndDelete deletes it afterwards.
.EXAMPLE
    PS> ./Remediate/Scripts/PurviewRetention/PURVIEW-RETENTION-003.ps1 -RetentionDays 2555 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/PurviewRetention/PURVIEW-RETENTION-003.ps1 -RetentionDays 2555
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'M365-Assess Teams retention',

    [Parameter(Mandatory)]
    [ValidateRange(1, 36500)]
    [int]$RetentionDays,

    [Parameter()]
    [ValidateSet('Keep', 'KeepAndDelete', 'Delete')]
    [string]$RetentionAction = 'Keep'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SecurityCompliance'

$locations = @{
    TeamsChannelLocation = 'All'
    TeamsChatLocation = 'All'
}

$step1 = @{
    CheckId   = 'PURVIEW-RETENTION-003'
    Target    = "Retention policy $PolicyName"
    Desired   = 'Exists, enabled, covers the locations'
    GetState  = {
        Get-RetentionCompliancePolicy -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.Enabled -ne $false -and (@($State.TeamsChannelLocation).Count -gt 0 -or @($State.TeamsChatLocation).Count -gt 0)
    }
    SetState  = {
        param($State)
        if ($null -eq $State) {
            New-RetentionCompliancePolicy -Name $PolicyName @locations | Out-Null
        }
        else {
            $add = @{}
            foreach ($key in $locations.Keys) { $add["Add$key"] = 'All' }
            Set-RetentionCompliancePolicy -Identity $PolicyName -Enabled $true @add
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'PURVIEW-RETENTION-003'
    Target    = "Retention rule for $PolicyName"
    Desired   = "Retain $RetentionDays days ($RetentionAction)"
    GetState  = {
        Get-RetentionComplianceRule -Policy $PolicyName -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State
    }
    SetState  = {
        param($State)
        $ruleParams = @{
            Name                       = "$PolicyName rule"
            Policy                     = $PolicyName
            RetentionDuration          = $RetentionDays
            RetentionComplianceAction  = $RetentionAction
        }
        New-RetentionComplianceRule @ruleParams | Out-Null
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
