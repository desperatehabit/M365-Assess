<#
.SYNOPSIS
    Remediates DEFENDER-PRIORITY-002: Ensure Priority accounts have 'Strict protection' presets applied
.DESCRIPTION
    Applies the Strict preset security policy to your priority accounts (executives, finance,
    IT admins) so they get the most aggressive filtering.

    Desired state: Strict preset applied to the chosen recipients
    Requires: Exchange Online (Connect-ExchangeOnline).

    The preset policies (and their rules) only exist after the preset has been turned on once in
    the Defender portal (Email & collaboration > Policies & rules > Threat policies > Preset
    security policies). If the rule is missing, this script reports Failed with that instruction.
    Recipients already assigned are replaced by the ones you pass.

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PriorityUser
    Priority users (email addresses).
.PARAMETER PriorityGroup
    Groups whose members are priority accounts.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-PRIORITY-002.ps1 -PriorityGroup 'Priority Accounts' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-PRIORITY-002.ps1 -PriorityGroup 'Priority Accounts'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$PriorityUser,

    [Parameter()]
    [string[]]$PriorityGroup
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$scope = @{}
if (@($PriorityUser | Where-Object { $_ }).Count -gt 0) { $scope['SentTo'] = @($PriorityUser) }
if (@($PriorityGroup | Where-Object { $_ }).Count -gt 0) { $scope['SentToMemberOf'] = @($PriorityGroup) }
if ($scope.Count -eq 0) { throw 'Pass -PriorityUser and/or -PriorityGroup.' }

$step1 = @{
    CheckId   = 'DEFENDER-PRIORITY-002'
    Target    = "EOP strict preset rule"
    Desired   = 'Enabled for chosen recipients'
    GetState  = {
        $rule = Get-EOPProtectionPolicyRule -Identity 'Strict Preset Security Policy' -ErrorAction SilentlyContinue
        if ($null -eq $rule) { throw 'The Strict preset security policy has not been turned on yet. Turn it on once in the Defender portal, then re-run.' }
        $rule
    }
    TestState = {
        param($State)
        $State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected $scope)
    }
    SetState  = {
        param($State)
        Set-EOPProtectionPolicyRule -Identity 'Strict Preset Security Policy' @scope
        if ($State.State -ne 'Enabled') { Enable-EOPProtectionPolicyRule -Identity 'Strict Preset Security Policy' -Confirm:$false }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'DEFENDER-PRIORITY-002'
    Target    = "Defender for Office 365 strict preset rule"
    Desired   = 'Enabled for chosen recipients (if licensed)'
    GetState  = {
        Get-ATPProtectionPolicyRule -Identity 'Strict Preset Security Policy' -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -eq $State -or ($State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected $scope))
    }
    SetState  = {
        param($State)
        Set-ATPProtectionPolicyRule -Identity 'Strict Preset Security Policy' @scope
        if ($State.State -ne 'Enabled') { Enable-ATPProtectionPolicyRule -Identity 'Strict Preset Security Policy' -Confirm:$false }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
