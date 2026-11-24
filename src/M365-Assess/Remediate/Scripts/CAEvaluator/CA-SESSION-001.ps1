<#
.SYNOPSIS
    Remediates CA-SESSION-001: Persistent browser sessions allowed without device compliance
.DESCRIPTION
    Fixes policies that keep browser sessions persistent without requiring a managed device: sets
    persistent browser to never, or adds a compliant-device requirement.

    Desired state: No persistent-browser policy without device compliance
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    Triage bucket: Needs decision (Policy template (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Action
    NeverPersist: change persistent browser to Never. RequireCompliantDevice: keep persistence but
    add compliant / hybrid-joined device to the grant (AND).
.PARAMETER PolicyId
    Limit to these policies. Defaults to every enabled policy that matches the finding.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-SESSION-001.ps1 -Action NeverPersist -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-SESSION-001.ps1 -Action NeverPersist
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateSet('NeverPersist', 'RequireCompliantDevice')]
    [string]$Action,

    [Parameter()]
    [string[]]$PolicyId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$step = @{
    CheckId   = 'CA-SESSION-001'
    Target    = 'Persistent-browser policies without device compliance'
    Desired   = "Fixed by $Action"
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $_ } | Where-Object {
            $_['state'] -eq 'enabled' -and $_['sessionControls'] -and $_['sessionControls']['persistentBrowser'] -and
            $_['sessionControls']['persistentBrowser']['mode'] -eq 'always' -and $_['sessionControls']['persistentBrowser']['isEnabled'] -eq $true -and
            -not (@($_['grantControls']['builtInControls']) -contains 'compliantDevice' -or @($_['grantControls']['builtInControls']) -contains 'domainJoinedDevice') -and
            (@($PolicyId | Where-Object { $_ }).Count -eq 0 -or @($PolicyId) -contains $_['id'])
        } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Grant = $_['grantControls'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($p in $State) {
            if ($Action -eq 'NeverPersist') {
                $patch = @{ sessionControls = @{ persistentBrowser = @{ isEnabled = $true; mode = 'never' } } }
            }
            else {
                $controls = @(@($p.Grant['builtInControls']) + 'compliantDevice' | Where-Object { $_ } | Sort-Object -Unique)
                $patch = @{ grantControls = @{ operator = 'AND'; builtInControls = $controls } }
            }
            Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($p.Id)" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 20) | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
