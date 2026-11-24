<#
.SYNOPSIS
    Remediates CA-LEGACYAUTH-001: Enable Conditional Access policies to block legacy authentication
.DESCRIPTION
    Creates a Conditional Access policy that blocks legacy authentication (Exchange ActiveSync and
    other legacy clients) for all users and apps.

    Desired state: "Conditional Access policy '$PolicyName' in state $PolicyState"
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    New policies are created in report-only mode by default. Review the sign-in impact
    (Entra admin center > Conditional Access > Insights and reporting), then re-run with
    -PolicyState enabled.
    If security defaults are on, turn them off when enabling this (CA and security defaults cannot
    both be active). Check sign-in logs for legacy clients first.

    Triage bucket: Needs decision (Policy template (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER BreakGlassAccountId
    Object IDs of emergency-access (break-glass) accounts to exclude, so a misconfiguration
    cannot lock every administrator out.
.PARAMETER ExcludeGroupId
    Object IDs of groups to exclude (pilot exceptions, service accounts).
.PARAMETER PolicyState
    Policy state. Defaults to report-only (enabledForReportingButNotEnforced) so you can review
    sign-in impact in the CA insights workbook first. The assessment check only passes once the
    policy is 'enabled'.
.PARAMETER PolicyName
    Display name of the policy to create or update.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-LEGACYAUTH-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-LEGACYAUTH-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$BreakGlassAccountId,

    [Parameter()]
    [string[]]$ExcludeGroupId,

    [Parameter()]
    [ValidateSet('enabledForReportingButNotEnforced', 'enabled', 'disabled')]
    [string]$PolicyState = 'enabledForReportingButNotEnforced',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'M365-Assess - Block legacy authentication'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$excludeUsers = @($BreakGlassAccountId | Where-Object { $_ })
$excludeGroups = @($ExcludeGroupId | Where-Object { $_ })
$policy = @{
    conditions    = @{
        clientAppTypes = @('exchangeActiveSync', 'other')
        applications   = @{ includeApplications = @('All') }
        users = @{
            includeUsers  = @('All')
            excludeUsers  = $excludeUsers
            excludeGroups = $excludeGroups
        }
    }
    grantControls = @{ operator = 'OR'; builtInControls = @('block') }
}
$policy['displayName'] = $PolicyName
$policy['state'] = $PolicyState

$step = @{
    CheckId   = 'CA-LEGACYAUTH-001'
    Target    = "Conditional Access policy $PolicyName"
    Desired   = "$PolicyState, settings as defined"
    GetState  = {
        Get-RemediationCaPolicy -DisplayName $PolicyName
    }
    TestState = {
        param($State)
        Test-RemediationCaPolicy -State $State -Policy $policy
    }
    SetState  = {
        param($State)
        Set-RemediationCaPolicy -Existing $State -Policy $policy
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
