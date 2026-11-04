<#
.SYNOPSIS
    Remediates ENTRA-DEVICE-004: Ensure local administrator assignment is limited during Entra join
.DESCRIPTION
    Removes the "additional local administrators on all Entra joined devices" assignment.

    Desired state: Device registration policy updated
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.DeviceConfiguration.

    Uses the Graph beta device registration policy, which is updated with a full PUT of the
    current policy plus the change. Users listed there lose local admin on every Entra-joined device. Grant scoped access
    with Intune Endpoint privilege management or Account protection policies instead.

    Triage bucket: Scriptable (Tenant setting (beta API)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-004.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-004.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.DeviceConfiguration'

$step = @{
    CheckId   = 'ENTRA-DEVICE-004'
    Target    = 'Entra device registration policy'
    Desired   = 'Removes the "additional local administrators on all Entra joined devices" assignment'
    GetState  = {
        Get-RemediationGraphObject -Uri '/beta/policies/deviceRegistrationPolicy'
    }
    TestState = {
        param($State)
        "$($State['azureADJoin']['localAdmins']['registeredUsers']['@odata.type'])" -match 'noDeviceRegistrationMembership'
    }
    SetState  = {
        param($State)
        $body = @{}
        foreach ($key in $State.Keys) { if ($key -notlike '@odata.*') { $body[$key] = $State[$key] } }
        $body['azureADJoin']['localAdmins']['registeredUsers'] = @{ '@odata.type' = '#microsoft.graph.noDeviceRegistrationMembership' }
        Set-RemediationGraphObject -Uri '/beta/policies/deviceRegistrationPolicy' -Method PUT -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
