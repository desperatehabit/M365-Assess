<#
.SYNOPSIS
    Remediates EXO-AUTH-002: Ensure SMTP AUTH is disabled
.DESCRIPTION
    Turns off SMTP AUTH client submission for the whole organization, then re-enables it only for
    the mailboxes you list (devices or apps that still need it).

    Desired state: SmtpClientAuthenticationDisabled = True org-wide; enabled only for -AllowMailbox
    Requires: Exchange Online (Connect-ExchangeOnline).

    Anything that sends through smtp.office365.com:587 with basic SMTP AUTH and is not listed in
    -AllowMailbox stops sending.

    Triage bucket: Needs decision (User-impacting setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER AllowMailbox
    Mailboxes (UPN) that must keep SMTP AUTH, such as multifunction printers or line-of-business
    apps. Find current users in the SMTP AUTH clients report before running.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUTH-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUTH-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$AllowMailbox
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step1 = @{
    CheckId   = 'EXO-AUTH-002'
    Target    = 'Transport config (org-wide SMTP AUTH)'
    Desired   = 'SmtpClientAuthenticationDisabled = $true'
    GetState  = {
        Get-TransportConfig
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            SmtpClientAuthenticationDisabled = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            SmtpClientAuthenticationDisabled = $true
        }
        Set-TransportConfig @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'EXO-AUTH-002'
    Target    = "Per-mailbox SMTP AUTH exceptions"
    Desired   = 'Enabled only for -AllowMailbox'
    GetState  = {
        @(foreach ($mailbox in @($AllowMailbox | Where-Object { $_ })) {
            Get-CASMailbox -Identity $mailbox | Select-Object -Property Identity, PrimarySmtpAddress, SmtpClientAuthenticationDisabled
        })
    }
    TestState = {
        param($State)
        @($State | Where-Object { $null -ne $_ -and $_.SmtpClientAuthenticationDisabled -ne $false }).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($mailbox in @($State | Where-Object { $null -ne $_ -and $_.SmtpClientAuthenticationDisabled -ne $false })) {
            Set-CASMailbox -Identity $mailbox.Identity -SmtpClientAuthenticationDisabled $false
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
