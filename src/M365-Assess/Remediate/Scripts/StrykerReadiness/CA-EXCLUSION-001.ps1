<#
.SYNOPSIS
    Remediates CA-EXCLUSION-001: Privileged admins excluded from Conditional Access policies
.DESCRIPTION
    Removes privileged administrators from Conditional Access policy user exclusions, keeping only
    your break-glass accounts excluded.

    Desired state: No enabled CA policy excludes a privileged admin (other than break-glass)
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.ConditionalAccess, Policy.Read.All, RoleManagement.Read.Directory.

    Admins that were excluded become subject to those policies immediately (MFA, device, location).
    Use PIM just-in-time activation instead of standing exclusions.

    Triage bucket: Needs decision (Per-object review (CA)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER BreakGlassAccountId
    Object IDs of emergency-access accounts, which are always left alone.
.PARAMETER RoleDefinitionId
    Privileged role template IDs to evaluate. Defaults to the core admin roles listed in the script.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/CA-EXCLUSION-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/CA-EXCLUSION-001.ps1 -BreakGlassAccountId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$BreakGlassAccountId,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string[]]$RoleDefinitionId = @(
    '62e90394-69f5-4237-9190-012177145e10', # Global Administrator
    'e8611ab8-c189-46e8-94e1-60213ab1f814', # Privileged Role Administrator
    '7be44c8a-adaf-4e2a-84d6-ab2649e08a13', # Privileged Authentication Administrator
    '194ae4cb-b126-40b2-bd5b-6091b380977d', # Security Administrator
    'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9', # Conditional Access Administrator
    '3a2c62db-5318-420d-8d74-23affee5d9d5', # Intune Administrator
    '29232cdf-9323-42fd-ade2-1d097af3e4de', # Exchange Administrator
    'fe930be7-5e62-47db-91af-98c3a49a38b1', # User Administrator
    '158c047a-c907-4556-b7ef-446551a6b5f7', # Cloud Application Administrator
    '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3' # Application Administrator
)
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'RoleManagement.Read.Directory'

$step = @{
    CheckId   = 'CA-EXCLUSION-001'
    Target    = 'CA policies excluding privileged admins'
    Desired   = 'Only break-glass excluded'
    GetState  = {
        $adminIds = @(foreach ($roleId in $RoleDefinitionId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'" -OutputType HashTable)['value']) |
                Where-Object { $_ } | ForEach-Object { $_['principalId'] }
        }) | Sort-Object -Unique
        @(@((Invoke-MgGraphRequest -Method GET -Uri '/v1.0/identity/conditionalAccess/policies' -OutputType HashTable)['value']) | Where-Object { $null -ne $_ -and $_['state'] -eq 'enabled' } | ForEach-Object {
            $excluded = @($_['conditions']['users']['excludeUsers'])
            $admins = @($excluded | Where-Object { $adminIds -contains $_ -and @($BreakGlassAccountId) -notcontains $_ })
            if ($admins.Count -gt 0) { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName']; Users = $_['conditions']['users']; ExcludeUsers = $excluded; ExcludedAdmins = $admins } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($p in $State) {
            $keep = @($p.ExcludeUsers | Where-Object { $p.ExcludedAdmins -notcontains $_ })
            $users = @{}
            foreach ($k in $p.Users.Keys) { $users[$k] = $p.Users[$k] }
            $users['excludeUsers'] = $keep
            $patch = @{ conditions = @{ users = $users } }
            Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/identity/conditionalAccess/policies/$($p.Id)" -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Depth 10) | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
