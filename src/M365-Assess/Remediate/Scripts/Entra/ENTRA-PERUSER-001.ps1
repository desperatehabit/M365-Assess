<#
.SYNOPSIS
    Remediates ENTRA-PERUSER-001: Ensure 'Per-user MFA' is disabled
.DESCRIPTION
    Turns off legacy per-user MFA (Enabled / Enforced) for every user, leaving MFA to Conditional
    Access.

    Desired state: perUserMfaState = disabled for all users
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod, User.Read.All.

    Uses the Graph beta authentication requirements endpoint. Enumerating every user is slow in
    large tenants; pass -UserId for a pilot.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ConfirmCaEnforcesMfa
    Confirms that Conditional Access (or security defaults) already requires MFA for these users.
    Without that, turning per-user MFA off removes MFA.
.PARAMETER UserId
    Limit to these users. Defaults to every user (one request per user).
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PERUSER-001.ps1 -ConfirmCaEnforcesMfa -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PERUSER-001.ps1 -ConfirmCaEnforcesMfa
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [switch]$ConfirmCaEnforcesMfa,

    [Parameter()]
    [string[]]$UserId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.AuthenticationMethod', 'User.Read.All'

$step = @{
    CheckId   = 'ENTRA-PERUSER-001'
    Target    = 'Users with per-user MFA enabled or enforced'
    Desired   = 'None'
    GetState  = {
        $ids = if (@($UserId | Where-Object { $_ }).Count -gt 0) { @($UserId) } else {
            $all = [System.Collections.Generic.List[string]]::new()
            $uri = "/v1.0/users?`$select=id&`$top=999"
            while ($uri) {
                $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType HashTable
                foreach ($u in @($page['value'])) { if ($u) { $all.Add($u['id']) } }
                $uri = $page['@odata.nextLink']
            }
            @($all)
        }
        @(foreach ($id in $ids) {
            $req = Invoke-MgGraphRequest -Method GET -Uri "/beta/users/$id/authentication/requirements" -OutputType HashTable
            if ($req['perUserMfaState'] -and $req['perUserMfaState'] -ne 'disabled') { [PSCustomObject]@{ Id = $id; State = $req['perUserMfaState'] } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($user in $State) {
            Set-RemediationGraphObject -Uri "/beta/users/$($user.Id)/authentication/requirements" -Body @{ perUserMfaState = 'disabled' }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
