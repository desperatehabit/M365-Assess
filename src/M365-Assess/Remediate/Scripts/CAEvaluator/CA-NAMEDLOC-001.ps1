<#
.SYNOPSIS
    Remediates CA-NAMEDLOC-001: Trusted IP-based named locations susceptible to spoofing
.DESCRIPTION
    Removes the "trusted" flag from the IP-based named locations you name, so policies stop treating
    those IP ranges as inherently safe.

    Desired state: Listed IP named locations not trusted
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All.

    Policies that exclude "All trusted locations" will start applying on those networks (for
    example MFA from the office). Consider Global Secure Access compliant network instead.

    Triage bucket: Needs decision (Per-object review (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER NamedLocationId
    IDs of the IP named locations to untrust.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-NAMEDLOC-001.ps1 -NamedLocationId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/CAEvaluator/CA-NAMEDLOC-001.ps1 -NamedLocationId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$NamedLocationId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All'

$step = @{
    CheckId   = 'CA-NAMEDLOC-001'
    Target    = 'Listed trusted IP named locations'
    Desired   = 'Not trusted'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/namedLocations' -OutputType HashTable)['value']) | Where-Object {
            $null -ne $_ -and @($NamedLocationId) -contains $_['id'] -and $_['@odata.type'] -eq '#microsoft.graph.ipNamedLocation' -and $_['isTrusted'] -eq $true
        } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($location in $State) {
            Set-RemediationGraphObject -Uri "/v1.0/identity/conditionalAccess/namedLocations/$($location.Id)" -Body @{ '@odata.type' = '#microsoft.graph.ipNamedLocation'; isTrusted = $false }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
