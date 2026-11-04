<#
.SYNOPSIS
    Remediates CA-STALEREF-001: CA policies reference deleted or invalid groups
.DESCRIPTION
    Removes references to deleted groups from Conditional Access policy include and exclude lists.

    Desired state: No policy references a deleted group
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All, Group.Read.All.

    A policy whose only include target is a deleted group is skipped and reported (removing it would
    leave the policy targeting nobody).

    Triage bucket: Needs decision (Per-object review (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-STALEREF-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-STALEREF-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All', 'Group.Read.All'

$step = @{
    CheckId   = 'CA-STALEREF-001'
    Target    = 'Policies referencing deleted groups'
    Desired   = 'References removed'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object {
            $users = $_['conditions']['users']
            $refs = @(@($users['includeGroups']) + @($users['excludeGroups']) | Where-Object { $_ } | Sort-Object -Unique)
            $stale = @($refs | Where-Object {
                $id = $_
                try { $null = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$id`?`$select=id" -ErrorAction Stop; $false } catch { "$($_.Exception.Message)" -match '404|NotFound|does not exist' }
            })
            if ($stale.Count -gt 0) { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Conditions = $users; Stale = $stale } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($p in $State) {
            $section = $p.Conditions
            $patch = @{ conditions = @{ users = @{} } }
            $skip = $false
            foreach ($field in @('includeGroups', 'excludeGroups')) {
                $kept = @($section[$field] | Where-Object { $_ -and @($p.Stale) -notcontains $_ })
                if ($field -like 'include*' -and @($section[$field]).Count -gt 0 -and $kept.Count -eq 0 -and @($section['includeUsers'] | Where-Object { $_ -and $_ -ne 'None' }).Count -eq 0 -and @($section['includeRoles']).Count -eq 0) {
                    Write-Warning "Skipping $($p.DisplayName): removing the stale $field entries would leave it with no include target. Fix it manually or with CA-FALLBACK-001."
                    $skip = $true
                }
                $patch['conditions']['users'][$field] = $kept
            }
            if (-not $skip) { Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($p.Id)" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 20) | Out-Null }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
