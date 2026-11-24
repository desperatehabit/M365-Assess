<#
.SYNOPSIS
    Remediates TEAMS-APPS-002: Ensure app permission policies are configured
.DESCRIPTION
    Sets the Global Teams app permission policy so third-party apps are blocked, or allowed
    only from an approved list. Microsoft and custom (org) apps are not changed.

    Desired state: Third-party apps blocked, or limited to -AllowedAppId
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Tenants migrated to app-centric management manage app availability per app in the Teams
    admin center instead; in that case Set-CsTeamsAppPermissionPolicy is rejected and this script
    reports Failed. Use Teams admin center > Manage apps for those tenants.

    Triage bucket: Needs decision (Business preference).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER AllowedAppId
    Teams app IDs (from the Teams admin center or Get-TeamsApp) of approved third-party apps.
    Omit to block all third-party apps.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-APPS-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-APPS-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$AllowedAppId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Teams'

$apps = @($AllowedAppId | Where-Object { $_ } | ForEach-Object {
    New-Object -TypeName 'Microsoft.Teams.Policy.Administration.Cmdlets.Core.GlobalCatalogApp' -Property @{ Id = $_ }
})

$step = @{
    CheckId   = 'TEAMS-APPS-002'
    Target    = 'Teams app permission policy Global'
    Desired   = 'Third-party (global catalog) apps restricted'
    GetState  = {
        Get-CsTeamsAppPermissionPolicy -Identity Global
    }
    TestState = {
        param($State)
        $current = @($State.GlobalCatalogApps | ForEach-Object { $_.Id } | Sort-Object)
        $State.GlobalCatalogAppsType -eq 'AllowedAppList' -and ($current -join ',') -eq (@($AllowedAppId | Where-Object { $_ } | Sort-Object) -join ',')
    }
    SetState  = {
        param($State)
        Set-CsTeamsAppPermissionPolicy -Identity Global -GlobalCatalogAppsType AllowedAppList -GlobalCatalogApps $apps
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
