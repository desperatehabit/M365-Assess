<#
.SYNOPSIS
    Remediates INTUNE-MAA-001: Multi-Admin Approval not enabled for destructive operations
.DESCRIPTION
    Turns on Intune Multi Admin Approval for destructive operations (wipe, retire, delete, scripts,
    apps), with approvals from the group you name.

    Desired state: An approval policy exists for each -PolicyType
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementRBAC.ReadWrite.All.

    Uses the Graph beta operationApprovalPolicies endpoint. Once on, every protected operation
    needs a second admin to approve it in Tenant administration > Multi Admin Approval.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApproverGroupId
    Groups whose members approve requests (cannot approve their own).
.PARAMETER PolicyType
    Operation types to protect.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/INTUNE-MAA-001.ps1 -ApproverGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/INTUNE-MAA-001.ps1 -ApproverGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ApproverGroupId,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string[]]$PolicyType = @('deviceWipe', 'deviceRetire', 'deviceDelete', 'script', 'app')
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementRBAC.ReadWrite.All'

$step = @{
    CheckId   = 'INTUNE-MAA-001'
    Target    = 'Intune Multi Admin Approval policies'
    Desired   = 'One per operation type'
    GetState  = {
        $existing = @(@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/operationApprovalPolicies' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object { "$($_['policyType'])" })
        @($PolicyType | Where-Object { $existing -notcontains $_ })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($type in $State) {
            Set-RemediationGraphObject -Uri '/beta/deviceManagement/operationApprovalPolicies' -Method POST -Body @{
                displayName      = "M365-Assess - Approval for $type"
                description      = 'Created by M365-Assess remediation INTUNE-MAA-001'
                policyType       = $type
                policyPlatform   = 'notApplicable'
                approverGroupIds = @($ApproverGroupId)
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
