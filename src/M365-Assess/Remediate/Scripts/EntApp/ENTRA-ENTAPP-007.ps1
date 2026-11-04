<#
.SYNOPSIS
    Remediates ENTRA-ENTAPP-007: App instance property lock not enabled
.DESCRIPTION
    Turns on the tenant default app management policy, which enforces credential restrictions on
    app registrations and service principals.

    Desired state: isEnabled = $true
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ApplicationConfiguration.

    Add restrictions (for example a maximum secret lifetime, or blocking new secrets) in the
    same policy; some restriction types need Workload ID Premium. Per-app instance property lock
    is set on each multi-tenant app under Authentication > App instance property lock.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-007.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/EntApp/ENTRA-ENTAPP-007.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ApplicationConfiguration'

$expected = @{
    'isEnabled' = $true
}
$body = @{
    isEnabled = $true
}

$step = @{
    CheckId   = 'ENTRA-ENTAPP-007'
    Target    = 'Tenant default app management policy'
    Desired   = 'isEnabled = $true'
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/defaultAppManagementPolicy'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/v1.0/policies/defaultAppManagementPolicy' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
