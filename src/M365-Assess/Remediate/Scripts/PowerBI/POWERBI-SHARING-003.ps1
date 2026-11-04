<#
.SYNOPSIS
    Remediates POWERBI-SHARING-003: Ensure shareable links are restricted in Power BI
.DESCRIPTION
    Updates the Fabric tenant setting 'ShareLinkToEntireOrg' through the Fabric admin API.
    Users can no longer create "people in your organization" links.

    Desired state: ShareLinkToEntireOrg disabled, or enabled only for -AllowedSecurityGroupId
    Requires: Power BI (Connect-PowerBIServiceAccount) as a Fabric administrator.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SettingName
    Fabric tenant setting name. Defaults to 'ShareLinkToEntireOrg', the name the Power BI collector reads.
    Override if your tenant lists the setting under a different name.
.PARAMETER AllowedSecurityGroupId
    Optional Entra security group object IDs. When supplied, the setting stays enabled
    but only for these groups (the CIS-acceptable "specific security groups" option)
    instead of being turned off for everyone.
.EXAMPLE
    PS> ./Remediate/Scripts/PowerBI/POWERBI-SHARING-003.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/PowerBI/POWERBI-SHARING-003.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$SettingName = 'ShareLinkToEntireOrg',

    [Parameter()]
    [string[]]$AllowedSecurityGroupId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'PowerBI'

$step = @{
    CheckId   = 'POWERBI-SHARING-003'
    Target    = "Fabric tenant setting $SettingName"
    Desired   = 'ShareLinkToEntireOrg disabled, or enabled only for -AllowedSecurityGroupId'
    GetState  = {
        Get-PowerBITenantSettingState -SettingName $SettingName
    }
    TestState = {
        param($State)
        if ($AllowedSecurityGroupId.Count -gt 0) {
            $current = @($State.enabledSecurityGroups | ForEach-Object { $_.graphId })
            $State.enabled -eq $true -and $current.Count -gt 0 -and @($current | Where-Object { $AllowedSecurityGroupId -notcontains $_ }).Count -eq 0
        }
        else {
            $State.enabled -eq $false
        }
    }
    SetState  = {
        param($State)
        if ($AllowedSecurityGroupId.Count -gt 0) {
            Set-PowerBITenantSettingState -SettingName $SettingName -Enabled $true -EnabledSecurityGroupIds $AllowedSecurityGroupId
        }
        else {
            Set-PowerBITenantSettingState -SettingName $SettingName -Enabled $false
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
