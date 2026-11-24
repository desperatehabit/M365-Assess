<#
.SYNOPSIS
    Remediates INTUNE-AUTODISC-001: Ensure automated device discovery and enrollment is configured
.DESCRIPTION
    Turns on Windows automatic MDM enrollment into Intune for all users, or the groups you name
    (Entra ID > Mobility (MDM and WIP) > Microsoft Intune > MDM user scope).

    Desired state: Intune MDM user scope = All or Selected
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.MobilityManagement.

    Uses the Graph beta mobileDeviceManagementPolicies endpoint (Intune app ID
    0000000a-0000-0000-c000-000000000000). The assessment reads deviceEnrollmentConfigurations,
    so confirm the check recognizes the change.

    Triage bucket: Scriptable (Tenant setting (beta API)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER GroupId
    Groups to scope enrollment to. Omit for All users.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-AUTODISC-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-AUTODISC-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$GroupId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.MobilityManagement'

$intuneMdm = '/beta/policies/mobileDeviceManagementPolicies/0000000a-0000-0000-c000-000000000000'
$wanted = if (@($GroupId | Where-Object { $_ }).Count -gt 0) { 'selected' } else { 'all' }

$step = @{
    CheckId   = 'INTUNE-AUTODISC-001'
    Target    = 'Intune MDM user scope'
    Desired   = "$wanted"
    GetState  = {
        Get-RemediationGraphObject -Uri $intuneMdm
    }
    TestState = {
        param($State)
        $State['appliesTo'] -eq $wanted
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri $intuneMdm -Body @{ appliesTo = $wanted }
        foreach ($g in @($GroupId | Where-Object { $_ })) {
            Set-RemediationGraphObject -Uri "$intuneMdm/includedGroups/`$ref" -Method POST -Body @{ '@odata.id' = "https://graph.microsoft.com/beta/groups/$g" }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
