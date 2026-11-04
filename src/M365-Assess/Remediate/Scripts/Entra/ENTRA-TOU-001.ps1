<#
.SYNOPSIS
    Remediates ENTRA-TOU-001: Ensure Terms of Use agreement policy is configured
.DESCRIPTION
    Creates a Terms of Use agreement from your PDF, requiring users to open it before accepting.

    Desired state: A Terms of Use agreement with isViewingBeforeAcceptanceRequired = true exists
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Agreement.ReadWrite.All.

    The agreement only takes effect once a Conditional Access policy requires it (grant control
    "Require terms of use"). Requires Entra ID P1.

    Triage bucket: Needs decision (Policy template).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PdfPath
    Path to the Terms of Use PDF.
.PARAMETER AgreementName
    Display name of the agreement.
.PARAMETER Language
    Language code of the PDF.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-TOU-001.ps1 -PdfPath '.\TermsOfUse.pdf' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-TOU-001.ps1 -PdfPath '.\TermsOfUse.pdf'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$PdfPath,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$AgreementName = 'Terms of Use',

    [Parameter()]
    [string]$Language = 'en'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Agreement.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-TOU-001'
    Target    = "Terms of Use agreement $AgreementName"
    Desired   = 'Exists, viewing required'
    GetState  = {
        @((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identityGovernance/termsOfUse/agreements' -OutputType HashTable)['value']) | Where-Object { $null -ne $_ -and $_['displayName'] -eq $AgreementName } | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State -and $State['isViewingBeforeAcceptanceRequired'] -eq $true
    }
    SetState  = {
        param($State)
        if ($null -ne $State) {
            Set-RemediationGraphObject -Uri "/v1.0/identityGovernance/termsOfUse/agreements/$($State['id'])" -Body @{ isViewingBeforeAcceptanceRequired = $true }
        }
        else {
            $data = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $PdfPath).Path))
            Set-RemediationGraphObject -Uri '/v1.0/identityGovernance/termsOfUse/agreements' -Method POST -Body @{
                displayName                       = $AgreementName
                isViewingBeforeAcceptanceRequired = $true
                isPerDeviceAcceptanceRequired     = $false
                file                              = @{ fileName = (Split-Path -Path $PdfPath -Leaf); language = $Language; isDefault = $true; fileData = @{ data = $data } }
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
