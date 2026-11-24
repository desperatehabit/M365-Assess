<#
.SYNOPSIS
    Remediates DEFENDER-PRIORITY-001: Ensure Priority account protection is enabled and configured
.DESCRIPTION
    Applies the Standard preset security policy (EOP and, where licensed, Defender for Office 365)
    to all recipients in the domains you choose, as the org-wide protection baseline.

    Desired state: Standard preset applied to the chosen recipients
    Requires: Exchange Online (Connect-ExchangeOnline).

    The preset policies (and their rules) only exist after the preset has been turned on once in
    the Defender portal (Email & collaboration > Policies & rules > Threat policies > Preset
    security policies). If the rule is missing, this script reports Failed with that instruction.
    Recipients already assigned are replaced by the ones you pass.

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RecipientDomain
    Domains the preset covers. Defaults to every accepted domain.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-PRIORITY-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-PRIORITY-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$RecipientDomain
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$domains = if (@($RecipientDomain | Where-Object { $_ }).Count -gt 0) { @($RecipientDomain) } else { @(Get-AcceptedDomain | ForEach-Object { "$($_.DomainName)" }) }
$scope = @{ RecipientDomainIs = $domains }

$step1 = @{
    CheckId   = 'DEFENDER-PRIORITY-001'
    Target    = "EOP standard preset rule"
    Desired   = 'Enabled for chosen recipients'
    GetState  = {
        $rule = Get-EOPProtectionPolicyRule -Identity 'Standard Preset Security Policy' -ErrorAction SilentlyContinue
        if ($null -eq $rule) { throw 'The Standard preset security policy has not been turned on yet. Turn it on once in the Defender portal, then re-run.' }
        $rule
    }
    TestState = {
        param($State)
        $State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected $scope)
    }
    SetState  = {
        param($State)
        Set-EOPProtectionPolicyRule -Identity 'Standard Preset Security Policy' @scope
        if ($State.State -ne 'Enabled') { Enable-EOPProtectionPolicyRule -Identity 'Standard Preset Security Policy' -Confirm:$false }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'DEFENDER-PRIORITY-001'
    Target    = "Defender for Office 365 standard preset rule"
    Desired   = 'Enabled for chosen recipients (if licensed)'
    GetState  = {
        Get-ATPProtectionPolicyRule -Identity 'Standard Preset Security Policy' -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -eq $State -or ($State.State -eq 'Enabled' -and (Test-RemediationProperty -State $State -Expected $scope))
    }
    SetState  = {
        param($State)
        Set-ATPProtectionPolicyRule -Identity 'Standard Preset Security Policy' @scope
        if ($State.State -ne 'Enabled') { Enable-ATPProtectionPolicyRule -Identity 'Standard Preset Security Policy' -Confirm:$false }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
