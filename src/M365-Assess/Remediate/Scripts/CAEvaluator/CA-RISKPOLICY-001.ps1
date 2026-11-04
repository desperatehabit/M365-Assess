<#
.SYNOPSIS
    Remediates CA-RISKPOLICY-001: CA policy combines sign-in risk and user risk (anti-pattern)
.DESCRIPTION
    Splits Conditional Access policies that combine sign-in risk and user risk (an AND condition that
    rarely triggers) into two policies, one per risk type, and turns the original off.

    Desired state: No enabled policy combines sign-in and user risk
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    The two new policies copy the original's users, apps, and controls and are created in
    report-only mode; enable them after review. The original is set to disabled, not deleted.

    Triage bucket: Needs decision (Per-object review (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyId
    IDs of the combined-risk policies to split.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-RISKPOLICY-001.ps1 -PolicyId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-RISKPOLICY-001.ps1 -PolicyId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$PolicyId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$step = @{
    CheckId   = 'CA-RISKPOLICY-001'
    Target    = 'Listed combined-risk policies'
    Desired   = 'Split into separate policies'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $_ } | Where-Object {
            @($PolicyId) -contains $_['id'] -and $_['state'] -eq 'enabled' -and @($_['conditions']['signInRiskLevels']).Count -gt 0 -and @($_['conditions']['userRiskLevels']).Count -gt 0
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($original in $State) {
            foreach ($kind in @('signIn', 'user')) {
                $copy = $original | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
                foreach ($key in @('id', 'createdDateTime', 'modifiedDateTime', 'templateId', '@odata.context')) { $copy.Remove($key) }
                $copy['displayName'] = "$($original['displayName']) ($kind risk)"
                $copy['state'] = 'enabledForReportingButNotEnforced'
                if ($kind -eq 'signIn') { $copy['conditions']['userRiskLevels'] = @() } else { $copy['conditions']['signInRiskLevels'] = @() }
                Invoke-MgGraphRequest -Method POST -Uri '/v1.0/identity/conditionalAccess/policies' -ContentType 'application/json' -Body ($copy | ConvertTo-Json -Depth 20) | Out-Null
            }
            $p = [PSCustomObject]@{ Id = $original['id'] }
            $patch = @{ state = 'disabled' }
            Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($p.Id)" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 20) | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
