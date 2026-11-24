<#
.SYNOPSIS
    Remediates SPO-AUTH-001: Ensure modern authentication for SharePoint applications is required
.DESCRIPTION
    Blocks apps that do not use modern authentication from SharePoint and OneDrive.

    Desired state: LegacyAuthProtocolsEnabled = $false
    Requires: SharePoint Online (Connect-SPOService).

    Older Office clients (2010 and earlier) and some third-party sync tools stop working.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-AUTH-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-AUTH-001.ps1
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
    CheckId   = 'SPO-AUTH-001'
    Target    = 'SharePoint Online tenant settings'
    Desired   = 'LegacyAuthProtocolsEnabled = $false'
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            LegacyAuthProtocolsEnabled = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            LegacyAuthProtocolsEnabled = $false
        }
        Set-SPOTenant @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
