<#
.SYNOPSIS
    Remediates ENTRA-DEVICE-001: Ensure the ability to join devices to Entra is restricted
.DESCRIPTION
    Limits who can join devices to Microsoft Entra to the groups you choose.

    Desired state: Device registration policy updated
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.DeviceConfiguration.

    Uses the Graph beta device registration policy, which is updated with a full PUT of the
    current policy plus the change. Autopilot and bulk enrollment accounts must be in an allowed group.

    Triage bucket: Scriptable (Tenant setting (beta API)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER AllowedGroupId
    Groups whose members may join devices to Entra (for example, IT and Autopilot accounts).
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-001.ps1 -AllowedGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-001.ps1 -AllowedGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$AllowedGroupId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.DeviceConfiguration'

$step = @{
    CheckId   = 'ENTRA-DEVICE-001'
    Target    = 'Entra device registration policy'
    Desired   = 'Limits who can join devices to Microsoft Entra to the groups you choose'
    GetState  = {
        Get-RemediationGraphObject -Uri '/beta/policies/deviceRegistrationPolicy'
    }
    TestState = {
        param($State)
        $State['azureADJoin']['allowedToJoin']['@odata.type'] -ne '#microsoft.graph.allDeviceRegistrationMembership'
    }
    SetState  = {
        param($State)
        $body = @{}
        foreach ($key in $State.Keys) { if ($key -notlike '@odata.*') { $body[$key] = $State[$key] } }
        $body['azureADJoin']['allowedToJoin'] = @{ '@odata.type' = '#microsoft.graph.enumeratedDeviceRegistrationMembership'; users = @(); groups = @($AllowedGroupId) }
        Set-RemediationGraphObject -Uri '/beta/policies/deviceRegistrationPolicy' -Method PUT -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
