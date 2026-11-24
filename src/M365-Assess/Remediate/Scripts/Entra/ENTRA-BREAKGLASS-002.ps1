<#
.SYNOPSIS
    Remediates ENTRA-BREAKGLASS-002: Ensure emergency access account activity is monitored
.DESCRIPTION
    Sends Entra sign-in and audit logs to a Log Analytics workspace and, optionally, creates an
    alert that fires on any sign-in by a break-glass account.

    Desired state: Diagnostic setting to Log Analytics (+ break-glass sign-in alert)
    Requires: Azure Resource Manager (Connect-AzAccount).

    Uses Azure Resource Manager (Invoke-AzRestMethod, Az.Accounts). Requires Entra ID P1/P2 for
    sign-in log export and Contributor on the workspace resource group. Log Analytics ingestion is billed.

    Triage bucket: Needs decision (Policy template).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER WorkspaceResourceId
    Resource ID of the Log Analytics workspace (/subscriptions/.../workspaces/<name>).
.PARAMETER BreakGlassUpn
    User principal names of break-glass accounts to alert on.
.PARAMETER ActionGroupResourceId
    Resource ID of the Azure Monitor action group the alert notifies (required with -BreakGlassUpn).
.PARAMETER SettingName
    Name of the diagnostic setting and alert rule.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-BREAKGLASS-002.ps1 -WorkspaceResourceId '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<ws>' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-BREAKGLASS-002.ps1 -WorkspaceResourceId '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<ws>'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$WorkspaceResourceId,

    [Parameter()]
    [string[]]$BreakGlassUpn,

    [Parameter()]
    [string]$ActionGroupResourceId,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$SettingName = 'M365-Assess-EntraLogs'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Azure'

$diagPath = "/providers/microsoft.aadiam/diagnosticSettings/$SettingName`?api-version=2017-04-01"
$diagBody = @{ properties = @{ workspaceId = $WorkspaceResourceId; logs = @(
    @{ category = 'SignInLogs'; enabled = $true }
    @{ category = 'AuditLogs'; enabled = $true }
    @{ category = 'NonInteractiveUserSignInLogs'; enabled = $true }
) } } | ConvertTo-Json -Depth 6
$rgId = ($WorkspaceResourceId -split '/providers/')[0]
$alertPath = "$rgId/providers/Microsoft.Insights/scheduledQueryRules/$SettingName-breakglass?api-version=2023-03-15-preview"

$step1 = @{
    CheckId   = 'ENTRA-BREAKGLASS-002'
    Target    = "Entra diagnostic setting $SettingName"
    Desired   = 'Sign-in and audit logs to the workspace'
    GetState  = {
        $response = Invoke-AzRestMethod -Method GET -Path $diagPath
        if ($response.StatusCode -eq 200) { $response.Content | ConvertFrom-Json } else { $null }
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.properties.workspaceId -eq $WorkspaceResourceId -and @($State.properties.logs | Where-Object { $_.category -eq 'SignInLogs' -and $_.enabled }).Count -gt 0
    }
    SetState  = {
        param($State)
        $r = Invoke-AzRestMethod -Method PUT -Path $diagPath -Payload $diagBody
        if ($r.StatusCode -ge 300) { throw "ARM returned $($r.StatusCode): $($r.Content)" }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'ENTRA-BREAKGLASS-002'
    Target    = "Break-glass sign-in alert $SettingName-breakglass"
    Desired   = 'Exists when -BreakGlassUpn is set'
    GetState  = {
        if (@($BreakGlassUpn | Where-Object { $_ }).Count -eq 0) { return 'not-requested' }
        $response = Invoke-AzRestMethod -Method GET -Path $alertPath
        if ($response.StatusCode -eq 200) { $response.Content | ConvertFrom-Json } else { $null }
    }
    TestState = {
        param($State)
        $State -eq 'not-requested' -or $null -ne $State
    }
    SetState  = {
        param($State)
        if ([string]::IsNullOrWhiteSpace($ActionGroupResourceId)) { throw 'Pass -ActionGroupResourceId with -BreakGlassUpn.' }
        $upns = (@($BreakGlassUpn) | ForEach-Object { "'$_'" }) -join ','
        $alert = @{
            location   = (Invoke-AzRestMethod -Method GET -Path "$WorkspaceResourceId`?api-version=2022-10-01").Content | ConvertFrom-Json | Select-Object -ExpandProperty location
            properties = @{
                displayName = 'Break-glass account sign-in'
                severity = 0; enabled = $true; evaluationFrequency = 'PT5M'; windowSize = 'PT5M'
                scopes = @($WorkspaceResourceId)
                criteria = @{ allOf = @(@{ query = "SigninLogs | where UserPrincipalName in~ ($upns)"; timeAggregation = 'Count'; operator = 'GreaterThan'; threshold = 0 }) }
                actions = @{ actionGroups = @($ActionGroupResourceId) }
            }
        } | ConvertTo-Json -Depth 10
        $r = Invoke-AzRestMethod -Method PUT -Path $alertPath -Payload $alert
        if ($r.StatusCode -ge 300) { throw "ARM returned $($r.StatusCode): $($r.Content)" }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
