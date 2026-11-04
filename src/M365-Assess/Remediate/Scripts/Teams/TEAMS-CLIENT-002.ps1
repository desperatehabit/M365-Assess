<#
.SYNOPSIS
    Remediates TEAMS-CLIENT-002: Ensure users can't send emails to a channel email address
.DESCRIPTION
    Updates the Global Teams client configuration.
    Users can no longer email a channel address.

    Desired state: AllowEmailIntoChannel = $false
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Existing channel email addresses stop accepting mail.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-CLIENT-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-CLIENT-002.ps1
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
    CheckId   = 'TEAMS-CLIENT-002'
    Target    = 'Teams client configuration Global'
    Desired   = 'AllowEmailIntoChannel = $false'
    GetState  = {
        Get-CsTeamsClientConfiguration -Identity Global
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AllowEmailIntoChannel = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowEmailIntoChannel = $false
        }
        Set-CsTeamsClientConfiguration -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
