<#
.SYNOPSIS
    Remediates ENTRA-GROUP-004: Dynamic groups with user-controllable membership rules in privileged contexts
.DESCRIPTION
    Converts the dynamic groups you name to assigned membership, freezing their current members,
    so users cannot add themselves by editing attributes such as department or job title.

    Desired state: Listed groups use assigned membership
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Group.ReadWrite.All.

    Current members are kept; membership no longer updates automatically. Alternatively, rewrite
    the rule to use HR-sourced attributes (employeeId, extension attributes synced from HR).

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER GroupId
    Object IDs of the dynamic groups to convert (those used for role, app, or CA assignment).
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-004.ps1 -GroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-004.ps1 -GroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$GroupId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Group.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-GROUP-004'
    Target    = 'Dynamic groups to convert'
    Desired   = 'Assigned membership'
    GetState  = {
        @(foreach ($id in $GroupId) {
            $g = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$id`?`$select=id,displayName,groupTypes,membershipRule" -OutputType HashTable
            if (@($g['groupTypes']) -contains 'DynamicMembership') { [PSCustomObject]@{ Id = $g['id']; DisplayName = $g['displayName']; GroupTypes = @($g['groupTypes']); MembershipRule = $g['membershipRule'] } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($group in $State) {
            $types = @($group.GroupTypes | Where-Object { $_ -ne 'DynamicMembership' })
            Set-RemediationGraphObject -Uri "/v1.0/groups/$($group.Id)" -Body @{ groupTypes = $types; membershipRuleProcessingState = 'Paused' }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
