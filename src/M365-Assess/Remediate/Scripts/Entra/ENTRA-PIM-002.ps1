<#
.SYNOPSIS
    Remediates ENTRA-PIM-002: Ensure 'Access reviews' for Guest Users are configured
.DESCRIPTION
    Creates a recurring access review of guest users in every Microsoft 365 group, reviewed by
    the group owners (with fallback reviewers you name). Unreviewed guests are removed.

    Desired state: A recurring guest access review exists
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: AccessReview.ReadWrite.All.

    Requires Entra ID P2 or Entra ID Governance. Denied or unreviewed guests are removed from
    the group automatically at the end of each review.

    Triage bucket: Needs decision (Needs reviewers/approvers).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER FallbackReviewerId
    Object IDs of users who review when a group has no owner.
.PARAMETER ReviewName
    Display name of the review.
.PARAMETER IntervalMonths
    How often the review recurs, in months.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-002.ps1 -FallbackReviewerId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-002.ps1 -FallbackReviewerId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$FallbackReviewerId,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ReviewName = 'M365-Assess - Guest access review',

    [Parameter()]
    [ValidateSet(1, 3, 6, 12)]
    [int]$IntervalMonths = 3
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'AccessReview.ReadWrite.All'

$settings = @{
    mailNotificationsEnabled        = $true
    reminderNotificationsEnabled    = $true
    justificationRequiredOnApproval = $true
    defaultDecisionEnabled          = $true
    defaultDecision                 = 'Deny'
    instanceDurationInDays          = 14
    autoApplyDecisionsEnabled       = $true
    recommendationsEnabled          = $true
    recurrence                      = @{
        pattern = @{ type = 'absoluteMonthly'; interval = $IntervalMonths }
        range   = @{ type = 'noEnd'; startDate = (Get-Date).ToString('yyyy-MM-dd') }
    }
}

$step = @{
    CheckId   = 'ENTRA-PIM-002'
    Target    = "Access review $ReviewName"
    Desired   = 'Exists'
    GetState  = {
        @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/identityGovernance/accessReviews/definitions?`$filter=displayName eq '$($ReviewName.Replace("'", "''"))'" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State
    }
    SetState  = {
        param($State)
        $definition = @{
            displayName             = $ReviewName
            descriptionForAdmins    = 'Recurring review of guest access to Microsoft 365 groups.'
            descriptionForReviewers = 'Confirm each guest still needs access to this group.'
            instanceEnumerationScope = @{ '@odata.type' = '#microsoft.graph.accessReviewQueryScope'; query = "/groups?`$filter=(groupTypes/any(c:c+eq+'Unified'))"; queryType = 'MicrosoftGraph' }
            scope                   = @{ '@odata.type' = '#microsoft.graph.accessReviewQueryScope'; query = "./members/microsoft.graph.user/?`$count=true&`$filter=(userType eq 'Guest')"; queryType = 'MicrosoftGraph' }
            reviewers               = @(@{ query = './owners'; queryType = 'MicrosoftGraph' })
            fallbackReviewers       = @($FallbackReviewerId | ForEach-Object { @{ query = "/users/$_"; queryType = 'MicrosoftGraph' } })
            settings                = $settings
        }
        Set-RemediationGraphObject -Uri '/v1.0/identityGovernance/accessReviews/definitions' -Method POST -Body $definition
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
