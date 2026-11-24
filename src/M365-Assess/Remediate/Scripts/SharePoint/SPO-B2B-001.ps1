<#
.SYNOPSIS
    Remediates SPO-B2B-001: Ensure SharePoint and OneDrive integration with Azure AD B2B is enabled
.DESCRIPTION
    Turns on SharePoint and OneDrive integration with Entra B2B, so external users get guest
    accounts and Conditional Access applies to them.

    Desired state: EnableAzureADB2BIntegration = $true
    Requires: SharePoint Online (Connect-SPOService).

    Existing one-time-passcode shares keep working; new invitations create Entra guests.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-B2B-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-B2B-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$step = @{
    CheckId   = 'SPO-B2B-001'
    Target    = 'SharePoint Online tenant settings'
    Desired   = 'EnableAzureADB2BIntegration = $true'
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            EnableAzureADB2BIntegration = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            EnableAzureADB2BIntegration = $true
        }
        Set-SPOTenant @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
