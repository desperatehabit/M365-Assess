<#
.SYNOPSIS
    Remediates SPO-SESSION-001: Ensure 'Idle session timeout' is set to '3 hours (or less)' for unmanaged devices
.DESCRIPTION
    Creates the organization-wide idle session timeout policy (the Microsoft 365 admin center
    "Idle session timeout" setting), signing users out of Microsoft 365 web apps after inactivity.

    Desired state: An organization-default activity-based timeout policy with the chosen timeout
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ApplicationConfiguration.

    Applies to Outlook on the web, SharePoint, OneDrive, and other Microsoft 365 web apps. An
    existing policy is updated in place.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Timeout
    Idle time before sign-out, as hh:mm:ss. Defaults to 3 hours (the CIS maximum).
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SESSION-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SESSION-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidatePattern('^\d{2}:\d{2}:\d{2}$')]
    [string]$Timeout = '03:00:00'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ApplicationConfiguration'

$definition = @{ ActivityBasedTimeoutPolicy = @{ Version = 1; ApplicationPolicies = @(@{ ApplicationId = 'default'; WebSessionIdleTimeout = $Timeout }) } } | ConvertTo-Json -Depth 5 -Compress
$policyBody = @{
    displayName           = 'Idle session timeout'
    isOrganizationDefault = $true
    definition            = @($definition)
}

$step = @{
    CheckId   = 'SPO-SESSION-001'
    Target    = 'Activity-based timeout policy'
    Desired   = "Idle sign-out after $Timeout"
    GetState  = {
        @((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/policies/activityBasedTimeoutPolicies' -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State -and (@($State['definition']) -join '') -match [regex]::Escape("""WebSessionIdleTimeout"":""$Timeout""")
    }
    SetState  = {
        param($State)
        if ($null -eq $State) {
            Invoke-MgGraphRequest -Method POST -Uri '/v1.0/policies/activityBasedTimeoutPolicies' -Body ($policyBody | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null
        }
        else {
            Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/policies/activityBasedTimeoutPolicies/$($State['id'])" -Body (@{ definition = @($definition) } | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
