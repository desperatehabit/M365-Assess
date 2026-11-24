<#
.SYNOPSIS
    Remediates ENTRA-PIM-005: Ensure approval is required for Privileged Role Administrator activation
.DESCRIPTION
    Requires approval from the approvers you choose to activate Privileged Role Administrator.

    Desired state: PIM rule updated for each role
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleManagementPolicy.ReadWrite.Directory.

    Requires Entra ID P2 (PIM). Approvers cannot approve their own requests. Keep at least two approvers, and make sure
    break-glass accounts hold the role permanently so approval cannot lock you out.

    Triage bucket: Needs decision (Needs reviewers/approvers).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RoleDefinitionId
    Privileged Role Administrator role template IDs to change. Defaults to the Privileged Role Administrator roles listed in the script.
.PARAMETER ApproverGroupId
    Object IDs of groups whose members approve activation.
.PARAMETER ApproverUserId
    Object IDs of additional individual approvers.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-005.ps1 -ApproverGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-005.ps1 -ApproverGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string[]]$RoleDefinitionId = @(
    'e8611ab8-c189-46e8-94e1-60213ab1f814' # Privileged Role Administrator
),

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ApproverGroupId,

    [Parameter()]
    [string[]]$ApproverUserId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'RoleManagementPolicy.ReadWrite.Directory'

$approvers = @(
    @($ApproverUserId | Where-Object { $_ } | ForEach-Object { @{ '@odata.type' = '#microsoft.graph.singleUser'; userId = $_ } })
    @($ApproverGroupId | Where-Object { $_ } | ForEach-Object { @{ '@odata.type' = '#microsoft.graph.groupMembers'; groupId = $_ } })
)

$step = @{
    CheckId   = 'ENTRA-PIM-005'
    Target    = "PIM rule Approval_EndUser_Assignment for roles: $($RoleDefinitionId -join ', ')"
    Desired   = 'Updated'
    GetState  = {
        @(foreach ($roleId in $RoleDefinitionId) {
            $rule = Get-RemediationPimRule -RoleDefinitionId $roleId -RuleId 'Approval_EndUser_Assignment'
            $rule['roleDefinitionId'] = $roleId
            $rule
        })
    }
    TestState = {
        param($State)
        @($State | Where-Object { $rule = $_; -not ($rule['setting']['isApprovalRequired'] -eq $true -and @($rule['setting']['approvalStages'][0]['primaryApprovers']).Count -gt 0) }).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($rule in @($State | Where-Object { $rule = $_; -not ($rule['setting']['isApprovalRequired'] -eq $true -and @($rule['setting']['approvalStages'][0]['primaryApprovers']).Count -gt 0) })) {
            $current = @{}
            foreach ($key in $rule.Keys) { if ($key -ne 'roleDefinitionId') { $current[$key] = $rule[$key] } }
            Set-RemediationPimRule -Current $current -Changes (@{ setting = @{ isApprovalRequired = $true; isApprovalRequiredForExtension = $false; isRequestorJustificationRequired = $true; approvalMode = 'SingleStage'; approvalStages = @(@{ approvalStageTimeOutInDays = 1; isApproverJustificationRequired = $true; escalationTimeInMinutes = 0; isEscalationEnabled = $false; primaryApprovers = $approvers; escalationApprovers = @() }) } })
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
