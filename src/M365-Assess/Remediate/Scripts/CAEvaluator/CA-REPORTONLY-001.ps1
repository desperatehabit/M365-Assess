<#
.SYNOPSIS
    Remediates CA-REPORTONLY-001: Conditional Access policies in report-only mode
.DESCRIPTION
    Promotes the report-only Conditional Access policies you name to enforced, or turns them off.

    Desired state: Listed policies are no longer report-only
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    Review each policy's report-only results (CA insights workbook) before enabling.

    Triage bucket: Needs decision (Per-object review (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyId
    IDs of the report-only policies to change.
.PARAMETER Action
    Enable: enforce the policy. Disable: turn it off.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-REPORTONLY-001.ps1 -PolicyId '00000000-0000-0000-0000-000000000001' -Action Enable -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-REPORTONLY-001.ps1 -PolicyId '00000000-0000-0000-0000-000000000001' -Action Enable
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$PolicyId,

    [Parameter(Mandatory)]
    [ValidateSet('Enable', 'Disable')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$step = @{
    CheckId   = 'CA-REPORTONLY-001'
    Target    = 'Listed report-only policies'
    Desired   = "$Action"
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $_ } | Where-Object { @($PolicyId) -contains $_['id'] -and $_['state'] -eq 'enabledForReportingButNotEnforced' } |
            ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        $newState = if ($Action -eq 'Enable') { 'enabled' } else { 'disabled' }
        foreach ($p in $State) {
            $patch = @{ state = $newState }
            Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($p.Id)" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 20) | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
