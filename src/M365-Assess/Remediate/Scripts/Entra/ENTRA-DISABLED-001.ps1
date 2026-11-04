<#
.SYNOPSIS
    Remediates ENTRA-DISABLED-001: Disabled Member Account Count
.DESCRIPTION
    Deletes disabled member accounts that have not signed in for the number of days you choose.
    Deleted users can be restored for 30 days.

    Desired state: No disabled member accounts older than -InactiveDays
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: User.ReadWrite.All, AuditLog.Read.All.

    This check is informational in the assessment. Deleting a user also removes their mailbox
    and OneDrive after the retention period unless they are on hold; place holds first.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER InactiveDays
    Only delete disabled accounts with no sign-in for at least this many days.
.PARAMETER ExcludeUserId
    Accounts to keep (legal hold, audit, shared mailboxes).
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DISABLED-001.ps1 -InactiveDays 180 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DISABLED-001.ps1 -InactiveDays 180
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateRange(30, 3650)]
    [int]$InactiveDays,

    [Parameter()]
    [string[]]$ExcludeUserId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'User.ReadWrite.All', 'AuditLog.Read.All'

$step = @{
    CheckId   = 'ENTRA-DISABLED-001'
    Target    = 'Disabled member accounts past -InactiveDays'
    Desired   = 'Deleted'
    GetState  = {
        $cutoff = (Get-Date).ToUniversalTime().AddDays(-$InactiveDays)
        $uri = "/v1.0/users?`$filter=accountEnabled eq false and userType eq 'Member'&`$select=id,userPrincipalName,signInActivity&`$top=999"
        $found = [System.Collections.Generic.List[object]]::new()
        while ($uri) {
            $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType HashTable
            foreach ($u in @($page['value'])) {
                if ($null -eq $u -or @($ExcludeUserId) -contains $u['id']) { continue }
                $last = $u['signInActivity']['lastSignInDateTime']
                if ($null -eq $last -or [datetime]$last -lt $cutoff) { $found.Add([PSCustomObject]@{ Id = $u['id']; UserPrincipalName = $u['userPrincipalName']; LastSignIn = $last }) }
            }
            $uri = $page['@odata.nextLink']
        }
        @($found)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($user in $State) {
            Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/users/$($user.Id)" | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
