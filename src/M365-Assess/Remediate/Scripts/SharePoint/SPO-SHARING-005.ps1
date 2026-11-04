<#
.SYNOPSIS
    Remediates SPO-SHARING-005: Ensure guest access to a site or OneDrive will expire automatically
.DESCRIPTION
    Makes guest access to sites and OneDrive expire automatically after 30 days or fewer.

    Desired state: ExternalUserExpirationRequired = True, ExternalUserExpireInDays <= -Days
    Requires: SharePoint Online (Connect-SPOService).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Days
    Days after which guest access expires (1-30). An existing shorter period is kept.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-005.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-005.ps1
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
    CheckId   = 'SPO-SHARING-005'
    Target    = 'SharePoint Online guest access expiration'
    Desired   = "Required, $Days days or fewer"
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        $State.ExternalUserExpirationRequired -eq $true -and [int]$State.ExternalUserExpireInDays -ge 1 -and [int]$State.ExternalUserExpireInDays -le $Days
    }
    SetState  = {
        param($State)
        Set-SPOTenant -ExternalUserExpirationRequired $true -ExternalUserExpireInDays $Days
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
