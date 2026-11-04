<#
.SYNOPSIS
    Remediates PBI-AUTH-001: Ensure 'Block ResourceKey Authentication' is 'Enabled' in Power BI
.DESCRIPTION
    Updates the Fabric tenant setting 'BlockResourceKeyAuthentication' through the Fabric admin API.
    Resource-key authentication for streaming datasets is blocked.

    Desired state: BlockResourceKeyAuthentication enabled = True
    Requires: Power BI (Connect-PowerBIServiceAccount) as a Fabric administrator.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SettingName
    Fabric tenant setting name. Defaults to 'BlockResourceKeyAuthentication', the name the Power BI collector reads.
    Override if your tenant lists the setting under a different name.
.EXAMPLE
    PS> ./Remediate/Scripts/PowerBI/PBI-AUTH-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/PowerBI/PBI-AUTH-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$SettingName = 'BlockResourceKeyAuthentication'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'PowerBI'

$step = @{
    CheckId   = 'PBI-AUTH-001'
    Target    = "Fabric tenant setting $SettingName"
    Desired   = 'BlockResourceKeyAuthentication enabled = True'
    GetState  = {
        Get-PowerBITenantSettingState -SettingName $SettingName
    }
    TestState = {
        param($State)
        $State.enabled -eq $true
    }
    SetState  = {
        param($State)
        Set-PowerBITenantSettingState -SettingName $SettingName -Enabled $true
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
