<#
.SYNOPSIS
    Remediates ENTRA-GROUP-002: Ensure a dynamic group for guest users is created
.DESCRIPTION
    Creates a dynamic security group containing every guest user, for targeting guest policies
    and access reviews.

    Desired state: A dynamic group with rule (user.userType -eq "Guest") exists
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Group.ReadWrite.All.

    Requires Entra ID P1 for dynamic membership.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER GroupName
    Display name of the group to create.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$GroupName = 'All Guest Users (dynamic)'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Group.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-GROUP-002'
    Target    = 'Dynamic guest group'
    Desired   = 'Exists'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups?`$filter=groupTypes/any(c:c eq 'DynamicMembership')&`$select=id,displayName,membershipRule&`$top=999" -OutputType HashTable)['value']) |
            Where-Object { $null -ne $_ -and "$($_['membershipRule'])" -match 'user\.userType\s+-eq\s+"Guest"' })
    }
    TestState = {
        param($State)
        @($State).Count -gt 0
    }
    SetState  = {
        param($State)
        $nickname = ($GroupName -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
        $group = @{
            displayName                   = $GroupName
            description                   = 'All guest users. Created by M365-Assess remediation ENTRA-GROUP-002.'
            mailEnabled                   = $false
            mailNickname                  = $nickname
            securityEnabled               = $true
            groupTypes                    = @('DynamicMembership')
            membershipRule                = '(user.userType -eq "Guest")'
            membershipRuleProcessingState = 'On'
        }
        Set-RemediationGraphObject -Uri '/v1.0/groups' -Method POST -Body $group
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
