<#
.SYNOPSIS
    Remediates EXO-DKIM-001: DKIM Signing Configuration
.DESCRIPTION
    Turns on DKIM signing for accepted domains. Domains without a DKIM configuration get one
    created (disabled) and the two CNAME records to publish are written as warnings; run the
    script again after DNS has propagated to enable signing.

    Desired state: DKIM signing enabled for each target domain
    Requires: Exchange Online (Connect-ExchangeOnline).

    Enabling fails until the selector1/selector2 CNAMEs exist in public DNS; those domains
    report VerifyFailed with the records to publish.

    Triage bucket: Needs decision (Split (EXO + DNS)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER DomainName
    Domains to enable. Defaults to every authoritative accepted domain.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-DKIM-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-DKIM-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$DomainName
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$targets = if (@($DomainName | Where-Object { $_ }).Count -gt 0) { @($DomainName) } else {
    @(Get-AcceptedDomain | Where-Object { $_.DomainType -eq 'Authoritative' } | ForEach-Object { "$($_.DomainName)" })
}

$step = @{
    CheckId   = 'EXO-DKIM-001'
    Target    = "DKIM signing for: $($targets -join ', ')"
    Desired   = 'Enabled'
    GetState  = {
        @(foreach ($domain in $targets) {
            $config = Get-DkimSigningConfig -Identity $domain -ErrorAction SilentlyContinue
            [PSCustomObject]@{
                Domain          = $domain
                Exists          = $null -ne $config
                Enabled         = [bool]$config.Enabled
                Selector1CNAME  = $config.Selector1CNAME
                Selector2CNAME  = $config.Selector2CNAME
            }
        })
    }
    TestState = {
        param($State)
        @($State | Where-Object { $null -ne $_ -and -not $_.Enabled }).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($domain in @($State | Where-Object { $null -ne $_ -and -not $_.Enabled })) {
            if (-not $domain.Exists) {
                $created = New-DkimSigningConfig -DomainName $domain.Domain -Enabled $false
                Write-Warning "Publish for $($domain.Domain): selector1._domainkey CNAME $($created.Selector1CNAME); selector2._domainkey CNAME $($created.Selector2CNAME). Re-run after DNS propagates."
                continue
            }
            try {
                Set-DkimSigningConfig -Identity $domain.Domain -Enabled $true
            }
            catch {
                Write-Warning "Could not enable DKIM for $($domain.Domain) (publish selector1._domainkey CNAME $($domain.Selector1CNAME) and selector2._domainkey CNAME $($domain.Selector2CNAME)): $($_.Exception.Message)"
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
