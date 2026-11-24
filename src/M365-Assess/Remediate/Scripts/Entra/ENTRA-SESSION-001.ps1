<#
.SYNOPSIS
    Remediates ENTRA-SESSION-001: Ensure the option to remain signed in is hidden
.DESCRIPTION
    Hides the "Stay signed in?" prompt on the Microsoft sign-in page (company branding).

    Desired state: loginPageTextVisibilitySettings.hideKeepMeSignedIn = true
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: OrganizationalBranding.ReadWrite.All, Organization.Read.All.

    Applies to the default company branding. Create default branding first if the tenant has
    none (Entra admin center > Company branding); the step reports Failed until it exists.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-SESSION-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-SESSION-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'OrganizationalBranding.ReadWrite.All', 'Organization.Read.All'

$step = @{
    CheckId   = 'ENTRA-SESSION-001'
    Target    = 'Default company branding'
    Desired   = 'KMSI hidden'
    GetState  = {
        $orgId = @((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/organization?$select=id' -OutputType HashTable)['value'])[0]['id']
        $branding = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/organization/$orgId/branding" -Headers @{ 'Accept-Language' = '0' } -OutputType HashTable
        $branding['orgId'] = $orgId
        $branding
    }
    TestState = {
        param($State)
        $State['loginPageTextVisibilitySettings']['hideKeepMeSignedIn'] -eq $true
    }
    SetState  = {
        param($State)
        Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/organization/$($State['orgId'])/branding" -Headers @{ 'Accept-Language' = '0' } -ContentType 'application/json' -Body (@{ loginPageTextVisibilitySettings = @{ hideKeepMeSignedIn = $true } } | ConvertTo-Json -Depth 5) | Out-Null
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
