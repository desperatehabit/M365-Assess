<#
.SYNOPSIS
    Remediates EXO-ADDINS-001: Ensure users installing Outlook add-ins is not allowed
.DESCRIPTION
    Removes the My Marketplace Apps, My Custom Apps, and My ReadWriteMailbox Apps roles from role
    assignment policies, so users can no longer install Outlook add-ins themselves.

    Desired state: No add-in roles assigned through role assignment policies
    Requires: Exchange Online (Connect-ExchangeOnline).

    Admins can still deploy add-ins centrally (Integrated Apps). The assessment check also
    flags MyBaseOptions, which this script deliberately leaves alone because removing it breaks
    basic Outlook options for users; the check may stay at Review until that is fixed in the collector.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RoleAssignmentPolicy
    Role assignment policies to change. Defaults to every role assignment policy.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-ADDINS-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-ADDINS-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$RoleAssignmentPolicy
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$addInRoles = @('My Marketplace Apps', 'My Custom Apps', 'My ReadWriteMailbox Apps')
$policies = if (@($RoleAssignmentPolicy | Where-Object { $_ }).Count -gt 0) { @($RoleAssignmentPolicy) } else { @(Get-RoleAssignmentPolicy | ForEach-Object { $_.Name }) }

$step = @{
    CheckId   = 'EXO-ADDINS-001'
    Target    = "Add-in role assignments on: $($policies -join ', ')"
    Desired   = 'None'
    GetState  = {
        @(Get-ManagementRoleAssignment -RoleAssigneeType RoleAssignmentPolicy | Where-Object {
            $addInRoles -contains "$($_.Role)" -and $policies -contains "$($_.RoleAssigneeName)"
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($assignment in $State) {
            Remove-ManagementRoleAssignment -Identity $assignment.Identity -Confirm:$false
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
