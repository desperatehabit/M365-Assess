<#
.SYNOPSIS
    Remediates ENTRA-DEVICE-002: Ensure the maximum number of devices per user is limited
.DESCRIPTION
    Limits the number of devices each user can join or register.

    Desired state: Device registration policy updated
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.DeviceConfiguration.

    Uses the Graph beta device registration policy, which is updated with a full PUT of the
    current policy plus the change.

    Triage bucket: Scriptable (Tenant setting (beta API)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER MaxDevices
    Maximum devices per user (1-15). An existing lower limit is kept.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateRange(1, 15)]
    [int]$MaxDevices = 15
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.DeviceConfiguration'

$step = @{
    CheckId   = 'ENTRA-DEVICE-002'
    Target    = 'Entra device registration policy'
    Desired   = 'Limits the number of devices each user can join or register'
    GetState  = {
        Get-RemediationGraphObject -Uri '/beta/policies/deviceRegistrationPolicy'
    }
    TestState = {
        param($State)
        $null -ne $State['userDeviceQuota'] -and [int]$State['userDeviceQuota'] -le $MaxDevices
    }
    SetState  = {
        param($State)
        $body = @{}
        foreach ($key in $State.Keys) { if ($key -notlike '@odata.*') { $body[$key] = $State[$key] } }
        $body['userDeviceQuota'] = $MaxDevices
        Set-RemediationGraphObject -Uri '/beta/policies/deviceRegistrationPolicy' -Method PUT -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
