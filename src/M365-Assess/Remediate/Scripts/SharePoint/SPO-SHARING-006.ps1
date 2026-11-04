<#
.SYNOPSIS
    Remediates SPO-SHARING-006: Ensure reauthentication with verification code is restricted
.DESCRIPTION
    Requires people who use a verification code to re-authenticate after 30 days or fewer.

    Desired state: EmailAttestationRequired = True, EmailAttestationReAuthDays <= -Days
    Requires: SharePoint Online (Connect-SPOService).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Days
    Re-authentication interval in days (1-30). An existing shorter interval is kept.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-006.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-006.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateRange(1, 30)]
    [int]$Days = 30
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$step = @{
    CheckId   = 'SPO-SHARING-006'
    Target    = 'SharePoint Online verification code re-authentication'
    Desired   = "Required every $Days days or fewer"
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        $State.EmailAttestationRequired -eq $true -and [int]$State.EmailAttestationReAuthDays -ge 1 -and [int]$State.EmailAttestationReAuthDays -le $Days
    }
    SetState  = {
        param($State)
        Set-SPOTenant -EmailAttestationRequired $true -EmailAttestationReAuthDays $Days
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
