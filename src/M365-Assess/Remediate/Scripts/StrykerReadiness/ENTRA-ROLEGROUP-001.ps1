<#
.SYNOPSIS
    Remediates ENTRA-ROLEGROUP-001: Unprotected groups in privileged role assignments
.DESCRIPTION
    For each unprotected group you name that holds a privileged role, creates a role-assignable
    (protected) copy with the same members, gives it the same role assignments, and optionally
    removes the original group's assignments.

    Desired state: Role assignments held by role-assignable groups only
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Group.ReadWrite.All, RoleManagement.ReadWrite.Directory.

    Run once without -RemoveOriginalAssignment, confirm members can use the role through the new
    group, then run again with it. isAssignableToRole cannot be turned on for an existing group.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER GroupId
    Object IDs of the unprotected groups that hold directory roles.
.PARAMETER RemoveOriginalAssignment
    Also delete the original group's role assignments once the copy holds them.
.PARAMETER Suffix
    Text appended to the new group names.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-ROLEGROUP-001.ps1 -GroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-ROLEGROUP-001.ps1 -GroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$GroupId,

    [Parameter()]
    [switch]$RemoveOriginalAssignment,

    [Parameter()]
    [string]$Suffix = ' (protected)'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Group.ReadWrite.All', 'RoleManagement.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-ROLEGROUP-001'
    Target    = 'Role assignments held by unprotected groups'
    Desired   = 'Moved to protected copies'
    GetState  = {
        @(foreach ($id in $GroupId) {
            $g = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$id`?`$select=id,displayName,mailNickname,isAssignableToRole" -OutputType HashTable
            if ($g['isAssignableToRole'] -eq $true) { continue }
            $assignments = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$id'" -OutputType HashTable)['value']) | Where-Object { $_ }
            $name = "$($g['displayName'])$Suffix"
            $copy = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups?`$filter=displayName eq '$($name.Replace("'", "''"))'&`$select=id" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
            $copyHasRoles = $false
            if ($copy) { $copyHasRoles = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$($copy['id'])'" -OutputType HashTable)['value'] | Where-Object { $_ }).Count -ge @($assignments).Count }
            if (-not $copyHasRoles -or ($RemoveOriginalAssignment.IsPresent -and @($assignments).Count -gt 0)) {
                [PSCustomObject]@{ SourceId = $id; SourceName = $g['displayName']; Nickname = $g['mailNickname']; NewName = $name; CopyId = $copy['id']; CopyHasRoles = $copyHasRoles; Assignments = @($assignments) }
            }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($item in $State) {
            $copyId = $item.CopyId
            if (-not $copyId) {
                $new = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/groups' -OutputType HashTable -ContentType 'application/json' -Body (@{ displayName = $item.NewName; mailEnabled = $false; mailNickname = "$($item.Nickname)-protected"; securityEnabled = $true; isAssignableToRole = $true } | ConvertTo-Json)
                $copyId = $new['id']
                foreach ($member in @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$($item.SourceId)/members?`$select=id&`$top=999" -OutputType HashTable)['value'] | Where-Object { $_ })) {
                    Set-RemediationGraphObject -Uri "/v1.0/groups/$copyId/members/`$ref" -Method POST -Body @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$($member['id'])" }
                }
            }
            if (-not $item.CopyHasRoles) {
                foreach ($a in $item.Assignments) {
                    Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleAssignments' -Method POST -Body @{ principalId = $copyId; roleDefinitionId = $a['roleDefinitionId']; directoryScopeId = $a['directoryScopeId'] }
                }
            }
            if ($RemoveOriginalAssignment.IsPresent) {
                foreach ($a in $item.Assignments) { Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/roleManagement/directory/roleAssignments/$($a['id'])" | Out-Null }
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
