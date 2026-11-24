<#
.SYNOPSIS
    Remediates ENTRA-PIM-003: Ensure 'Access reviews' for privileged roles are configured
.DESCRIPTION
    Creates a recurring access review of everyone assigned the privileged roles you list (active
    and PIM eligible), reviewed by the reviewers you name.

    Desired state: A recurring privileged role access review exists
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: AccessReview.ReadWrite.All.

    Requires Entra ID P2 or Entra ID Governance. One review is created per role.

    Triage bucket: Needs decision (Needs reviewers/approvers).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ReviewerId
    Object IDs of reviewers (not the role holders themselves).
.PARAMETER RoleDefinitionId
    Roles to review. Defaults to Global Administrator and Privileged Role Administrator.
.PARAMETER IntervalMonths
    How often the review recurs, in months.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-003.ps1 -ReviewerId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-003.ps1 -ReviewerId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ReviewerId,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string[]]$RoleDefinitionId = @('62e90394-69f5-4237-9190-012177145e10', 'e8611ab8-c189-46e8-94e1-60213ab1f814'),

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
    CheckId   = 'ENTRA-PIM-003'
    Target    = 'Privileged role access reviews'
    Desired   = 'One per role'
    GetState  = {
        @(foreach ($roleId in $RoleDefinitionId) {
            $name = "M365-Assess - Role review $roleId"
            $existing = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/identityGovernance/accessReviews/definitions?`$filter=displayName eq '$name'" -OutputType HashTable)['value']) | Where-Object { $_ }
            if ($existing.Count -eq 0) { $roleId }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($roleId in $State) {
            $definition = @{
                displayName = "M365-Assess - Role review $roleId"
                scope       = @{ '@odata.type' = '#microsoft.graph.accessReviewQueryScope'; query = "/roleManagement/directory/roleAssignmentScheduleInstances?`$expand=principal&`$filter=(isof(principal,'microsoft.graph.user') and roleDefinitionId eq '$roleId')"; queryType = 'MicrosoftGraph' }
                reviewers   = @($ReviewerId | ForEach-Object { @{ query = "/users/$_"; queryType = 'MicrosoftGraph' } })
                settings    = $settings
            }
            Set-RemediationGraphObject -Uri '/v1.0/identityGovernance/accessReviews/definitions' -Method POST -Body $definition
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
