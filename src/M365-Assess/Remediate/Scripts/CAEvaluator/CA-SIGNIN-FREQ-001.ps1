<#
.SYNOPSIS
    Remediates CA-SIGNIN-FREQ-001: Ensure Sign-in frequency is enabled and browser sessions are not persistent for Administrative users
.DESCRIPTION
    Creates a Conditional Access policy that makes administrators re-authenticate every few hours
    and never keeps their browser sessions persistent.

    Desired state: "Conditional Access policy '$PolicyName' in state $PolicyState"
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    New policies are created in report-only mode by default. Review the sign-in impact
    (Entra admin center > Conditional Access > Insights and reporting), then re-run with
    -PolicyState enabled.

    Triage bucket: Needs decision (Policy template (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER BreakGlassAccountId
    Object IDs of emergency-access (break-glass) accounts to exclude, so a misconfiguration
    cannot lock every administrator out.
.PARAMETER AdminRoleId
    Directory role template IDs the policy targets. Defaults to the admin roles the assessment
    checks (Global, Privileged Role, Security, Exchange, SharePoint, and other administrators).
.PARAMETER Hours
    Re-authentication interval in hours for administrators.
.PARAMETER ExcludeGroupId
    Object IDs of groups to exclude (pilot exceptions, service accounts).
.PARAMETER PolicyState
    Policy state. Defaults to report-only (enabledForReportingButNotEnforced) so you can review
    sign-in impact in the CA insights workbook first. The assessment check only passes once the
    policy is 'enabled'.
.PARAMETER PolicyName
    Display name of the policy to create or update.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-SIGNIN-FREQ-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-SIGNIN-FREQ-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001'
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
    [ValidateNotNullOrEmpty()]
    [string[]]$AdminRoleId = @(
    '62e90394-69f5-4237-9190-012177145e10',
    'e8611ab8-c189-46e8-94e1-60213ab1f814',
    'fe930be7-5e62-47db-91af-98c3a49a38b1',
    'f28a1f50-f6e7-4571-818b-6a12f2af6b6c',
    '29232cdf-9323-42fd-ade2-1d097af3e4de',
    'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9',
    '194ae4cb-b126-40b2-bd5b-6091b380977d',
    '729827e3-9c14-49f7-bb1b-9608f156bbb8',
    '966707d0-3269-4727-9be2-8c3a10f19b9d',
    'fdd7a751-b60b-444a-984c-02652fe8fa1c',
    '11648597-926c-4cf3-9c36-bcebb0ba8dcc',
    '3a2c62db-5318-420d-8d74-23affee5d9d5',
    '158c047a-c907-4556-b7ef-446551a6b5f7',
    '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
    '7be44c8a-adaf-4e2a-84d6-ab2649e08a13',
    'c4e39bd9-1100-46d3-8c65-fb160da0071f',
    'b0f54661-2d74-4c50-afa3-1ec803f12efe',
    '44367163-eba1-44c3-98af-f5787879f96a',
    '8835291a-918c-4fd7-a9ce-faa49f0cf7d9',
    '112f9a7f-7249-4951-bd88-c42b60cebe72'
),

    [Parameter()]
    [ValidateRange(1, 24)]
    [int]$Hours = 4,

    [Parameter()]
    [string[]]$ExcludeGroupId,

    [Parameter()]
    [ValidateSet('enabledForReportingButNotEnforced', 'enabled', 'disabled')]
    [string]$PolicyState = 'enabledForReportingButNotEnforced',

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'M365-Assess - Admin sign-in frequency'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$excludeUsers = @($BreakGlassAccountId | Where-Object { $_ })
$excludeGroups = @($ExcludeGroupId | Where-Object { $_ })
$policy = @{
    conditions    = @{
        clientAppTypes = @('all')
        applications   = @{ includeApplications = @('All') }
        users = @{
            includeRoles  = @($AdminRoleId)
            excludeUsers  = $excludeUsers
            excludeGroups = $excludeGroups
        }
    }
    sessionControls = @{ signInFrequency = @{ isEnabled = $true; type = 'hours'; value = $Hours; frequencyInterval = 'timeBased'; authenticationType = 'primaryAndSecondaryAuthentication' }; persistentBrowser = @{ isEnabled = $true; mode = 'never' } }
}
$policy['displayName'] = $PolicyName
$policy['state'] = $PolicyState

$step = @{
    CheckId   = 'CA-SIGNIN-FREQ-001'
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
