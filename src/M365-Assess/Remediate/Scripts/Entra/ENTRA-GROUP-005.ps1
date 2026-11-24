<#
.SYNOPSIS
    Remediates ENTRA-GROUP-005: Sensitive groups not protected with role-assignable flag
.DESCRIPTION
    Creates a role-assignable (protected) copy of each sensitive group you name, with the same
    members. Role-assignable groups can only be managed by Privileged Role Administrators.

    Desired state: A role-assignable replacement exists for each -SourceGroupId
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Group.ReadWrite.All, RoleManagement.ReadWrite.Directory.

    isAssignableToRole cannot be turned on for an existing group. After this runs, move CA,
    app-role, and license assignments to the new groups, then delete the originals; the check
    only clears once the originals are gone.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SourceGroupId
    Object IDs of the sensitive security groups to replace.
.PARAMETER Suffix
    Text appended to the display name of each new group.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-005.ps1 -SourceGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-005.ps1 -SourceGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$SourceGroupId,

    [Parameter()]
    [string]$Suffix = ' (protected)'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Group.ReadWrite.All', 'RoleManagement.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-GROUP-005'
    Target    = 'Role-assignable replacement groups'
    Desired   = 'Created'
    GetState  = {
        @(foreach ($id in $SourceGroupId) {
            $g = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$id`?`$select=id,displayName,mailNickname,isAssignableToRole" -OutputType HashTable
            if ($g['isAssignableToRole'] -ne $true) {
                $name = "$($g['displayName'])$Suffix"
                $existing = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups?`$filter=displayName eq '$($name.Replace("'", "''"))'&`$select=id" -OutputType HashTable)['value'])
                if ($existing.Count -eq 0) { [PSCustomObject]@{ SourceId = $g['id']; NewName = $name; Nickname = "$($g['mailNickname'])-protected" } }
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
            $new = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/groups' -OutputType HashTable -ContentType 'application/json' -Body (@{
                displayName = $item.NewName; mailEnabled = $false; mailNickname = $item.Nickname; securityEnabled = $true; isAssignableToRole = $true
            } | ConvertTo-Json)
            $members = @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$($item.SourceId)/members?`$select=id&`$top=999" -OutputType HashTable)['value'])
            foreach ($member in $members) {
                Set-RemediationGraphObject -Uri "/v1.0/groups/$($new['id'])/members/`$ref" -Method POST -Body @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$($member['id'])" }
            }
            Write-Warning "Created $($item.NewName) ($($new['id'])). Move assignments from $($item.SourceId), then delete it."
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
