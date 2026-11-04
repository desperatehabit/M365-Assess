<#
.SYNOPSIS
    Remediates ENTRA-PRIVREMOTE-001: Ensure privileged commands require PIM activation for remote access
.DESCRIPTION
    Makes privileged (Global Administrator) access require PIM activation with MFA and a
    justification, and converts permanent assignments to eligible (break-glass accounts excepted).

    Desired state: GA activation requires MFA + justification; only break-glass accounts permanent
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleEligibilitySchedule.ReadWrite.Directory, RoleAssignmentSchedule.ReadWrite.Directory, RoleManagementPolicy.ReadWrite.Directory.

    Requires Entra ID P2.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER BreakGlassAccountId
    Object IDs of break-glass accounts that keep permanent active Global Administrator.
.PARAMETER EligibleDays
    Length of the new eligible assignments in days.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PRIVREMOTE-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PRIVREMOTE-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001'
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
Assert-RemediationConnection -Service 'Graph' -GraphScope 'RoleEligibilitySchedule.ReadWrite.Directory', 'RoleAssignmentSchedule.ReadWrite.Directory', 'RoleManagementPolicy.ReadWrite.Directory'

$step1 = @{
    CheckId   = 'ENTRA-PRIVREMOTE-001'
    Target    = 'PIM activation rule for Global Administrator'
    Desired   = 'MFA and justification required'
    GetState  = {
        Get-RemediationPimRule -RoleDefinitionId '62e90394-69f5-4237-9190-012177145e10' -RuleId 'Enablement_EndUser_Assignment'
    }
    TestState = {
        param($State)
        @($State['enabledRules']) -contains 'MultiFactorAuthentication' -and @($State['enabledRules']) -contains 'Justification'
    }
    SetState  = {
        param($State)
        Set-RemediationPimRule -Current $State -Changes @{ enabledRules = @(@($State['enabledRules']) + 'MultiFactorAuthentication' + 'Justification' | Sort-Object -Unique) }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'ENTRA-PRIVREMOTE-001'
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
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
