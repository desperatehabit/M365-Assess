<#
.SYNOPSIS
    Remediates DEFENDER-SAFEATTACH-001: Ensure Safe Attachments policy is enabled
.DESCRIPTION
    Creates (or updates) a Safe Attachments policy and rule covering every accepted domain, with
    the Block action and optional redirection of detected attachments to a security mailbox.

    Desired state: Safe Attachments policy enabled (Block) for all recipients
    Requires: Exchange Online (Connect-ExchangeOnline).

    Requires Defender for Office 365.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyName
    Name of the policy and rule to create or update.
.PARAMETER RecipientDomain
    Recipient domains the rule covers. Defaults to every accepted domain.
.PARAMETER RedirectAddress
    Mailbox that receives a copy of detected attachments. Omit to leave redirection off.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-SAFEATTACH-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-SAFEATTACH-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'Safe Attachments',

    [Parameter()]
    [string[]]$RecipientDomain,

    [Parameter()]
    [string]$RedirectAddress
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$domains = if (@($RecipientDomain | Where-Object { $_ }).Count -gt 0) { @($RecipientDomain) } else { @(Get-AcceptedDomain | ForEach-Object { "$($_.DomainName)" }) }
$expected = @{
    Enable = $true
    Action = 'Block'
}
if (-not [string]::IsNullOrWhiteSpace($RedirectAddress)) {
    $expected['Redirect'] = $true
    $expected['RedirectAddress'] = $RedirectAddress
}

$step1 = @{
    CheckId   = 'DEFENDER-SAFEATTACH-001'
    Target    = "Safe Attachments policy $PolicyName"
    Desired   = 'Enabled, Block'
    GetState  = {
        Get-SafeAttachmentPolicy -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        if ($null -eq $State) { New-SafeAttachmentPolicy -Name $PolicyName @expected | Out-Null }
        else { Set-SafeAttachmentPolicy -Identity $PolicyName @expected }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'DEFENDER-SAFEATTACH-001'
    Target    = "Safe Attachments rule $PolicyName"
    Desired   = 'Enabled for all target domains'
    GetState  = {
        Get-SafeAttachmentRule -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.State -eq 'Enabled' -and (@($domains | Where-Object { @($State.RecipientDomainIs) -notcontains $_ }).Count -eq 0)
    }
    SetState  = {
        param($State)
        if ($null -eq $State) { New-SafeAttachmentRule -Name $PolicyName -SafeAttachmentPolicy $PolicyName -RecipientDomainIs $domains | Out-Null }
        else {
            Set-SafeAttachmentRule -Identity $PolicyName -RecipientDomainIs $domains
            if ($State.State -ne 'Enabled') { Enable-SafeAttachmentRule -Identity $PolicyName -Confirm:$false }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
