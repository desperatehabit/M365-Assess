<#
.SYNOPSIS
    Remediates SPO-VERSIONING-001: Version history configuration
.DESCRIPTION
    Sets the tenant default version history limit for new document libraries to at least 100
    major versions, with no time-based expiry, so files can be rolled back after ransomware.

    Desired state: Manual version limits: MajorVersionLimit >= -MajorVersionLimit, no expiry
    Requires: SharePoint Online (Connect-SPOService).

    Applies to new libraries. Existing libraries keep their own limits; use
    New-SPOSiteManageVersionPolicyJob or library settings to change them.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER MajorVersionLimit
    Major versions to keep (100-50000). Defaults to 500, the SharePoint default.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-VERSIONING-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-VERSIONING-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateRange(100, 50000)]
    [int]$MajorVersionLimit = 500
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$step = @{
    CheckId   = 'SPO-VERSIONING-001'
    Target    = 'SharePoint Online default version limits'
    Desired   = "At least $MajorVersionLimit major versions, no expiry"
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        $State.EnableAutoExpirationVersionTrim -eq $false -and [int]$State.MajorVersionLimit -ge $MajorVersionLimit -and [int]$State.ExpireVersionsAfterDays -eq 0
    }
    SetState  = {
        param($State)
        Set-SPOTenant -EnableAutoExpirationVersionTrim $false -MajorVersionLimit $MajorVersionLimit -ExpireVersionsAfterDays 0
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
