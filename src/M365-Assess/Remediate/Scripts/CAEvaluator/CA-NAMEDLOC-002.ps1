<#
.SYNOPSIS
    Remediates CA-NAMEDLOC-002: CA policies reference stale or deleted named locations
.DESCRIPTION
    Removes references to deleted named locations from Conditional Access policies.

    Desired state: No policy references a missing named location
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    A policy whose only included location is stale is skipped (removing it would widen the policy)
    and reported, so it is fixed by hand.

    Triage bucket: Needs decision (Per-object review (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-NAMEDLOC-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-NAMEDLOC-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$step = @{
    CheckId   = 'CA-NAMEDLOC-002'
    Target    = 'Policies referencing deleted named locations'
    Desired   = 'References removed'
    GetState  = {
        $known = @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/namedLocations' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object { $_['id'] }) + @('All', 'AllTrusted', '00000000-0000-0000-0000-000000000000')
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object {
            $loc = $_['conditions']['locations']
            if ($loc) {
                $stale = @(@($loc['includeLocations']) + @($loc['excludeLocations']) | Where-Object { $_ -and $known -notcontains $_ })
                if ($stale.Count -gt 0) { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Conditions = $loc; Stale = $stale } }
            }
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
            $patch = @{ conditions = @{ locations = @{} } }
            $skip = $false
            foreach ($field in @('includeLocations', 'excludeLocations')) {
                $kept = @($section[$field] | Where-Object { $_ -and @($p.Stale) -notcontains $_ })
                if ($field -like 'include*' -and @($section[$field]).Count -gt 0 -and $kept.Count -eq 0 -and $true) {
                    Write-Warning "Skipping $($p.DisplayName): removing the stale $field entries would leave it with no include target. Fix it manually or with CA-FALLBACK-001."
                    $skip = $true
                }
                $patch['conditions']['locations'][$field] = $kept
            }
            if (-not $skip) { Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($p.Id)" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 20) | Out-Null }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
