<#
.SYNOPSIS
    Remediates ENTRA-ORGSETTING-004: Ensure shared bookings pages are restricted to select users
.DESCRIPTION
    Stops users on the default Outlook on the web policy from creating shared Bookings pages.
    Give approved staff a separate OWA mailbox policy with BookingsMailboxCreationEnabled on.

    Desired state: BookingsMailboxCreationEnabled = $false
    Requires: Exchange Online (Connect-ExchangeOnline).

    Existing shared booking pages keep working.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-ORGSETTING-004.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-ORGSETTING-004.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step = @{
    CheckId   = 'ENTRA-ORGSETTING-004'
    Target    = 'Default OWA mailbox policy (Bookings)'
    Desired   = 'BookingsMailboxCreationEnabled = $false'
    GetState  = {
        Get-OwaMailboxPolicy -Identity 'OwaMailboxPolicy-Default'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            BookingsMailboxCreationEnabled = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            BookingsMailboxCreationEnabled = $false
        }
        Set-OwaMailboxPolicy -Identity 'OwaMailboxPolicy-Default' @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
