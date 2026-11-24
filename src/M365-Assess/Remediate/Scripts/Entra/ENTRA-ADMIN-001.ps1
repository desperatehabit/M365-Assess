<#
.SYNOPSIS
    Remediates ENTRA-ADMIN-001: Ensure that between two and four global admins are designated
.DESCRIPTION
    Brings the number of active Global Administrators to between two and four by adding and/or
    removing the accounts you name.

    Desired state: 2-4 active Global Administrators
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleManagement.ReadWrite.Directory.

    Prefer PIM eligible assignments over active ones (see ENTRA-PIM-001). Never remove the last
    working Global Administrator or a break-glass account.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER AddUserId
    Object IDs of users to make Global Administrator (cloud-only accounts).
.PARAMETER RemoveUserId
    Object IDs of users to remove from Global Administrator.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-ADMIN-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-ADMIN-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$AddUserId,

    [Parameter()]
    [string[]]$RemoveUserId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'RoleManagement.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-ADMIN-001'
    Target    = 'Global Administrator active assignments'
    Desired   = '2-4, with -AddUserId present and -RemoveUserId absent'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '62e90394-69f5-4237-9190-012177145e10'&`$expand=principal" -OutputType HashTable)['value']) | Where-Object { $_ } |
            ForEach-Object { [PSCustomObject]@{ AssignmentId = $_['id']; PrincipalId = $_['principalId']; Name = $_['principal']['displayName'] } })
    }
    TestState = {
        param($State)
        $ids = @($State | ForEach-Object { $_.PrincipalId })
        $count = $ids.Count
        $count -ge 2 -and $count -le 4 -and @($AddUserId | Where-Object { $_ -and $ids -notcontains $_ }).Count -eq 0 -and @($RemoveUserId | Where-Object { $_ -and $ids -contains $_ }).Count -eq 0
    }
    SetState  = {
        param($State)
        $ids = @($State | ForEach-Object { $_.PrincipalId })
        $after = @($ids + @($AddUserId | Where-Object { $_ }) | Where-Object { @($RemoveUserId) -notcontains $_ } | Sort-Object -Unique)
        if ($after.Count -lt 1) { throw 'Refusing to remove every Global Administrator.' }
        if ($after.Count -lt 2 -or $after.Count -gt 4) { Write-Warning "After this change there will be $($after.Count) Global Administrators; the check wants 2-4." }
        foreach ($id in @($AddUserId | Where-Object { $_ -and $ids -notcontains $_ })) {
            Set-RemediationGraphObject -Uri '/v1.0/roleManagement/directory/roleAssignments' -Method POST -Body @{ principalId = $id; roleDefinitionId = '62e90394-69f5-4237-9190-012177145e10'; directoryScopeId = '/' }
        }
        foreach ($assignment in @($State | Where-Object { @($RemoveUserId) -contains $_.PrincipalId })) {
            Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/roleManagement/directory/roleAssignments/$($assignment.AssignmentId)" | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
