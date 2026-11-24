<#
.SYNOPSIS
    Remediates ENTRA-GUEST-004: Ensure that collaboration invitations are sent to allowed domains only
.DESCRIPTION
    Restricts who can invite guests and limits invitations to the external domains you allow.

    Desired state: allowInvitesFrom restricted; B2B invitations allowed only to -AllowedDomain
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.Authorization, Policy.ReadWrite.B2BManagement.

    The domain list is written to the B2BManagementPolicy through the Graph beta /legacy/policies
    endpoint, the same store the External collaboration settings page uses.

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER AllowedDomain
    External domains guests may be invited from. Replaces the current list.
.PARAMETER AllowInvitesFrom
    Who can invite guests.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GUEST-004.ps1 -AllowedDomain 'partner.example' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GUEST-004.ps1 -AllowedDomain 'partner.example'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$AllowedDomain,

    [Parameter()]
    [ValidateSet('adminsAndGuestInviters', 'adminsGuestInvitersAndAllMembers', 'none')]
    [string]$AllowInvitesFrom = 'adminsAndGuestInviters'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.Authorization', 'Policy.ReadWrite.B2BManagement'

$step1 = @{
    CheckId   = 'ENTRA-GUEST-004'
    Target    = 'Entra authorization policy (guest invitations)'
    Desired   = 'allowInvitesFrom = $AllowInvitesFrom'
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            'allowInvitesFrom' = $AllowInvitesFrom
        }
    }
    SetState  = {
        param($State)
        $body = @{
            allowInvitesFrom = $AllowInvitesFrom
        }
        Set-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'ENTRA-GUEST-004'
    Target    = 'B2B collaboration domain allow-list'
    Desired   = 'Only -AllowedDomain'
    GetState  = {
        $policy = @((Invoke-MgGraphRequest -Method GET -Uri '/beta/legacy/policies' -OutputType HashTable)['value']) | Where-Object { $null -ne $_ -and $_['type'] -eq 'B2BManagementPolicy' } | Select-Object -First 1
        if ($null -eq $policy) { return $null }
        $definition = (@($policy['definition']) -join '') | ConvertFrom-Json -AsHashtable
        [PSCustomObject]@{ Id = $policy['id']; Definition = $definition; Allowed = @($definition['B2BManagementPolicy']['InvitationsAllowedAndBlockedDomainsPolicy']['AllowedDomains']) }
    }
    TestState = {
        param($State)
        $null -ne $State -and ((@($State.Allowed | Sort-Object) -join ',') -eq (@($AllowedDomain | Sort-Object) -join ','))
    }
    SetState  = {
        param($State)
        $definition = if ($null -ne $State) { $State.Definition } else { @{ B2BManagementPolicy = @{} } }
        $definition['B2BManagementPolicy']['InvitationsAllowedAndBlockedDomainsPolicy'] = @{ AllowedDomains = @($AllowedDomain) }
        $body = @{ definition = @(($definition | ConvertTo-Json -Depth 10 -Compress)) }
        if ($null -ne $State) {
            Set-RemediationGraphObject -Uri "/beta/legacy/policies/$($State.Id)" -Body $body
        }
        else {
            $body['displayName'] = 'B2BManagementPolicy'
            $body['type'] = 'B2BManagementPolicy'
            $body['isOrganizationDefault'] = $true
            Set-RemediationGraphObject -Uri '/beta/legacy/policies' -Method POST -Body $body
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
