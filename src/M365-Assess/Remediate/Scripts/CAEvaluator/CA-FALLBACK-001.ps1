<#
.SYNOPSIS
    Remediates CA-FALLBACK-001: CA policies have no valid include target (applies to nobody)
.DESCRIPTION
    Fixes enabled Conditional Access policies whose include targets resolve to nobody: turns them off,
    or points them at the group you name.

    Desired state: Every enabled policy targets someone
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    Triage bucket: Needs decision (Per-object review (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Action
    Disable the policies, or set their include target to -IncludeGroupId.
.PARAMETER IncludeGroupId
    Groups to include when -Action IncludeGroup is used.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-FALLBACK-001.ps1 -Action Disable -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-FALLBACK-001.ps1 -Action Disable
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Disable', 'IncludeGroup')]
    [string]$Action,

    [Parameter()]
    [string[]]$IncludeGroupId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$step = @{
    CheckId   = 'CA-FALLBACK-001'
    Target    = 'Enabled policies with empty include targets'
    Desired   = "Fixed by $Action"
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $_ } | Where-Object {
            $u = $_['conditions']['users']
            $_['state'] -eq 'enabled' -and
            ((-not $u['includeUsers']) -or @($u['includeUsers']).Count -eq 0 -or @($u['includeUsers']) -contains 'None') -and
            @($u['includeGroups']).Count -eq 0 -and @($u['includeRoles']).Count -eq 0
        } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Users = $_['conditions']['users'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        if ($Action -eq 'IncludeGroup' -and @($IncludeGroupId | Where-Object { $_ }).Count -eq 0) { throw 'Pass -IncludeGroupId with -Action IncludeGroup.' }
        foreach ($p in $State) {
            if ($Action -eq 'Disable') {
                $patch = @{ state = 'disabled' }
            }
            else {
                $users = @{}
                foreach ($k in $p.Users.Keys) { $users[$k] = $p.Users[$k] }
                $users['includeUsers'] = @()
                $users['includeGroups'] = @($IncludeGroupId)
                $patch = @{ conditions = @{ users = $users } }
            }
            Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($p.Id)" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 20) | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
