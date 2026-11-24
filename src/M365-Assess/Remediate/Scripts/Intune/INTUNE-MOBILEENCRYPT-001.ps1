<#
.SYNOPSIS
    Remediates INTUNE-MOBILEENCRYPT-001: Ensure mobile device compliance policies require encryption
.DESCRIPTION
    Requires device encryption in every Android compliance policy, and a passcode (which turns on
    iOS data protection) in every iOS compliance policy.

    Desired state: All mobile compliance policies require encryption
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementConfiguration.ReadWrite.All.

    Only existing compliance policies are changed. If you have none, create them first (Intune >
    Devices > Compliance). iOS has no separate encryption setting; data protection is on whenever a
    passcode is set, so the check may still flag iOS policies.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-MOBILEENCRYPT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-MOBILEENCRYPT-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementConfiguration.ReadWrite.All'

$step = @{
    CheckId   = 'INTUNE-MOBILEENCRYPT-001'
    Target    = 'Mobile compliance policies without encryption'
    Desired   = 'Encryption required'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceCompliancePolicies' -OutputType HashTable)['value']) | Where-Object {
            $null -ne $_ -and (
                ($_['@odata.type'] -match 'android' -and $_['storageRequireEncryption'] -ne $true) -or
                ($_['@odata.type'] -match 'ios' -and $_['passcodeRequired'] -ne $true)
            )
        } | ForEach-Object { [PSCustomObject]@{ Id = $_['id']; Type = $_['@odata.type']; DisplayName = $_['displayName'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($policy in $State) {
            $patch = if ($policy.Type -match 'android') { @{ '@odata.type' = $policy.Type; storageRequireEncryption = $true } } else { @{ '@odata.type' = $policy.Type; passcodeRequired = $true } }
            Set-RemediationGraphObject -Uri "/beta/deviceManagement/deviceCompliancePolicies/$($policy.Id)" -Body $patch
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
