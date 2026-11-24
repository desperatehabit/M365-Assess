<#
.SYNOPSIS
    Remediates EXO-SHAREDMBX-001: Ensure sign-in to shared mailboxes is blocked
.DESCRIPTION
    Blocks sign-in (accountEnabled = false) for the Entra user behind every shared mailbox.
    Shared mailboxes are opened through delegated access, so their own sign-in is not needed.

    Desired state: accountEnabled = false for every shared mailbox user
    Requires: Exchange Online (Connect-ExchangeOnline), Microsoft Graph (Connect-MgGraph); Graph scopes: User.ReadWrite.All.

    Shared mailboxes that are deliberately signed in to directly (some legacy apps or scanners)
    will stop working; exclude them with -ExcludeMailbox.

    Triage bucket: Scriptable (Bulk object fix).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ExcludeMailbox
    User principal names of shared mailboxes to leave enabled.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-SHAREDMBX-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-SHAREDMBX-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$ExcludeMailbox
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline', 'Graph' -GraphScope 'User.ReadWrite.All'

$step = @{
    CheckId   = 'EXO-SHAREDMBX-001'
    Target    = 'Shared mailbox accounts'
    Desired   = 'Sign-in blocked'
    GetState  = {
        @(Get-Mailbox -RecipientTypeDetails SharedMailbox -ResultSize Unlimited |
            Where-Object { @($ExcludeMailbox) -notcontains $_.UserPrincipalName } |
            ForEach-Object {
                $user = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/users/$($_.ExternalDirectoryObjectId)?`$select=id,userPrincipalName,accountEnabled" -OutputType HashTable
                if ($user['accountEnabled'] -eq $true) { [PSCustomObject]@{ Id = $user['id']; UserPrincipalName = $user['userPrincipalName'] } }
            })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($account in $State) {
            Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/users/$($account.Id)" -Body (@{ accountEnabled = $false } | ConvertTo-Json) -ContentType 'application/json'
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
