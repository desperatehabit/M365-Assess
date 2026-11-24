<#
.SYNOPSIS
    Remediates ENTRA-PASSWORD-002: Ensure custom banned passwords lists are used
.DESCRIPTION
    Turns on the custom banned password list and adds your organization-specific terms.

    Desired state: EnableBannedTermCheck = True; BannedTermList includes -BannedTerm
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Directory.ReadWrite.All.

    Requires Entra ID P1. Users are only blocked from these terms on their next password change.

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER BannedTerm
    Terms to ban (up to 1000, 4-16 characters each). Existing terms are kept.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PASSWORD-002.ps1 -BannedTerm 'contoso', 'fabrikam' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PASSWORD-002.ps1 -BannedTerm 'contoso', 'fabrikam'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$BannedTerm
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Directory.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-PASSWORD-002'
    Target    = 'Password rule settings (custom banned passwords)'
    Desired   = 'Enforced with the given terms'
    GetState  = {
        Get-RemediationDirectorySetting -TemplateId '5cf42378-d67d-4f36-ba46-e8b86229381d'
    }
    TestState = {
        param($State)
        $have = @("$($State['BannedTermList'])" -split "`t" | Where-Object { $_ })
        $null -ne $State -and "$($State['EnableBannedTermCheck'])" -eq 'True' -and @($BannedTerm | Where-Object { $have -notcontains $_ }).Count -eq 0
    }
    SetState  = {
        param($State)
        $have = @("$($State['BannedTermList'])" -split "`t" | Where-Object { $_ })
        $list = @($have + $BannedTerm | Sort-Object -Unique) -join "`t"
        Set-RemediationDirectorySetting -TemplateId '5cf42378-d67d-4f36-ba46-e8b86229381d' -Values @{ EnableBannedTermCheck = 'True'; BannedTermList = $list }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
