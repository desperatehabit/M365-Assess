<#
.SYNOPSIS
    Remediates ENTRA-CONSENT-006: Ensure admin consent request sends email notifications to reviewers
.DESCRIPTION
    Turns on email notifications to reviewers for new admin consent requests.

    Desired state: Admin consent workflow on, reviewers set, notifications on
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConsentRequest.

    The workflow is configured with one PUT, so this script also enables the workflow,
    notifications, and reminders. Without -ReviewerId the existing reviewers are kept; if there
    are none the step reports Failed.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ReviewerId
    Object IDs of users who review admin consent requests. Use Application or Cloud
    Application Administrators, not Global Administrators.
    Omit to keep the current reviewers.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-006.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-006.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$ReviewerId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConsentRequest'

$step = @{
    CheckId   = 'ENTRA-CONSENT-006'
    Target    = 'Admin consent request policy'
    Desired   = 'Enabled with reviewers and notifications'
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/adminConsentRequestPolicy'
    }
    TestState = {
        param($State)
        $State['isEnabled'] -eq $true -and $State['notifyReviewers'] -eq $true
    }
    SetState  = {
        param($State)
        $reviewers = @($ReviewerId | Where-Object { $_ } | ForEach-Object { @{ query = "/users/$_"; queryType = 'MicrosoftGraph'; queryRoot = $null } })
        if ($reviewers.Count -eq 0) { $reviewers = @($State['reviewers']) }
        if ($reviewers.Count -eq 0) { throw 'The admin consent workflow needs at least one reviewer. Pass -ReviewerId.' }
        $body = @{
            isEnabled             = $true
            notifyReviewers       = $true
            remindersEnabled      = $true
            requestDurationInDays = if ($State['requestDurationInDays']) { $State['requestDurationInDays'] } else { 30 }
            reviewers             = $reviewers
        }
        Set-RemediationGraphObject -Uri '/v1.0/policies/adminConsentRequestPolicy' -Method PUT -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
