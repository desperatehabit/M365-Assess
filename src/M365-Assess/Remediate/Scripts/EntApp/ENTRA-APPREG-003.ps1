<#
.SYNOPSIS
    Remediates ENTRA-APPREG-003: Apps with HTTP (non-HTTPS) redirect URIs
.DESCRIPTION
    Replaces plain-HTTP redirect URIs with their HTTPS equivalents (or removes them) on the app
    registrations you name.

    Desired state: No plain-HTTP redirect URIs on the listed apps
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Application.ReadWrite.All.

    Developers who sign in to these apps from a local machine need a separate development app
    registration. The original URIs are returned in Before.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApplicationObjectId
    Object IDs of the app registrations to change (App registrations > Overview > Object ID).
.PARAMETER Action
    UpgradeToHttps (default) rewrites http:// to https://; Remove deletes the URI.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-APPREG-003.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-APPREG-003.ps1 -ApplicationObjectId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ApplicationObjectId,

    [Parameter()]
    [ValidateSet('UpgradeToHttps', 'Remove')]
    [string]$Action = 'UpgradeToHttps'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Application.ReadWrite.All'

$pattern = '^http://(?!localhost|127\.0\.0\.1)'

$step = @{
    CheckId   = 'ENTRA-APPREG-003'
    Target    = "plain-HTTP redirect URIs on $(@($ApplicationObjectId).Count) app(s)"
    Desired   = 'Removed'
    GetState  = {
        @(Get-RemediationApplication -ObjectId $ApplicationObjectId | ForEach-Object {
            $app = $_
            foreach ($platform in @('web', 'spa', 'publicClient')) {
                $bad = @($app[$platform]['redirectUris'] | Where-Object { $_ -match $pattern })
                if ($bad.Count -gt 0) { [PSCustomObject]@{ Id = $app['id']; DisplayName = $app['displayName']; Platform = $platform; Uris = @($app[$platform]['redirectUris']); Matching = $bad } }
            }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($finding in $State) {
            $platform = $finding.Platform
            $uris = $finding.Uris
            $new = if ($Action -eq 'UpgradeToHttps') { @($uris | ForEach-Object { if ($_ -match $pattern) { $_ -replace '^http://', 'https://' } else { $_ } }) } else { @($uris | Where-Object { $_ -notmatch $pattern }) }
            $current = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/applications/$($finding.Id)?`$select=$platform" -OutputType HashTable
            $block = @{}
            foreach ($key in $current[$platform].Keys) { if ($key -ne 'redirectUriSettings') { $block[$key] = $current[$platform][$key] } }
            $block['redirectUris'] = $new
            Set-RemediationGraphObject -Uri "/v1.0/applications/$($finding.Id)" -Body @{ $platform = $block }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
