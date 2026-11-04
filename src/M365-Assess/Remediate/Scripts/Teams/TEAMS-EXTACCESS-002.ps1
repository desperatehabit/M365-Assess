<#
.SYNOPSIS
    Remediates TEAMS-EXTACCESS-002: Ensure external Teams users cannot initiate conversations
.DESCRIPTION
    Updates the tenant federation configuration.
    Unmanaged Teams accounts can no longer start conversations with your users.

    Desired state: AllowTeamsConsumerInbound = $false
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-EXTACCESS-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-EXTACCESS-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Teams'

$step = @{
    CheckId   = 'TEAMS-EXTACCESS-002'
    Target    = 'Teams tenant federation configuration'
    Desired   = 'AllowTeamsConsumerInbound = $false'
    GetState  = {
        Get-CsTenantFederationConfiguration -Identity Global
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AllowTeamsConsumerInbound = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowTeamsConsumerInbound = $false
        }
        Set-CsTenantFederationConfiguration -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
