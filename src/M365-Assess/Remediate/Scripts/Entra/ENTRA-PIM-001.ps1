<#
.SYNOPSIS
    Remediates ENTRA-PIM-001: Ensure 'Privileged Identity Management' is used to manage roles
.DESCRIPTION
    Converts permanent active Global Administrator assignments into time-bound PIM eligible
    assignments, keeping your break-glass accounts permanent.

    Desired state: Only break-glass accounts hold permanent active Global Administrator
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleEligibilitySchedule.ReadWrite.Directory, RoleAssignmentSchedule.ReadWrite.Directory.

    Requires Entra ID P2. Converted admins must activate the role in PIM before admin work;
    configure activation rules (ENTRA-PIM-006/007/008) first.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER BreakGlassAccountId
    Object IDs of break-glass accounts that keep permanent active Global Administrator.
.PARAMETER EligibleDays
    Length of the new eligible assignments in days.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001'
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
    [ValidateRange(15, 365)]
    [int]$EligibleDays = 365
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'RoleEligibilitySchedule.ReadWrite.Directory', 'RoleAssignmentSchedule.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-PIM-001'
    Target    = 'Permanent active Global Administrator assignments (excluding break-glass)'
    Desired   = 'Converted to PIM eligible'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignmentSchedules?`$filter=roleDefinitionId eq '62e90394-69f5-4237-9190-012177145e10'" -OutputType HashTable)['value']) |
            Where-Object { $null -ne $_ -and $_['assignmentType'] -eq 'Assigned' -and @($BreakGlassAccountId) -notcontains $_['principalId'] -and $_['scheduleInfo']['expiration']['type'] -eq 'noExpiration' } |
            ForEach-Object { [PSCustomObject]@{ PrincipalId = $_['principalId'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        $start = (Get-Date).ToUniversalTime().ToString('o')
        foreach ($item in $State) {
            Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleEligibilityScheduleRequests' -Method POST -Body @{
                action = 'adminAssign'; justification = 'M365-Assess remediation: convert permanent GA to eligible'; roleDefinitionId = '62e90394-69f5-4237-9190-012177145e10'; directoryScopeId = '/'; principalId = $item.PrincipalId
                scheduleInfo = @{ startDateTime = $start; expiration = @{ type = 'afterDuration'; duration = "P$($EligibleDays)D" } }
            }
            Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleAssignmentScheduleRequests' -Method POST -Body @{
                action = 'adminRemove'; justification = 'M365-Assess remediation: convert permanent GA to eligible'; roleDefinitionId = '62e90394-69f5-4237-9190-012177145e10'; directoryScopeId = '/'; principalId = $item.PrincipalId
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
