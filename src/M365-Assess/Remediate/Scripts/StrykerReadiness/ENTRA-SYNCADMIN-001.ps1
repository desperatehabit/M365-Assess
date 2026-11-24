<#
.SYNOPSIS
    Remediates ENTRA-SYNCADMIN-001: On-premises synced admin accounts (compromise path)
.DESCRIPTION
    Removes core admin role assignments from accounts synced from on-premises AD, after you have
    set up cloud-only replacement admins.

    Desired state: No synced account holds a core admin role
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleManagement.ReadWrite.Directory, User.Read.All.

    Same approach as ENTRA-HYBRID-002, scoped to the core admin roles.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RoleDefinitionId
    Privileged role template IDs to evaluate. Defaults to the core admin roles listed in the script.
.PARAMETER ExcludeUserId
    Synced accounts to leave as they are.
.PARAMETER ConfirmReplacementAccounts
    Confirms cloud-only replacement admins already hold these roles.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-SYNCADMIN-001.ps1 -ConfirmReplacementAccounts -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/StrykerReadiness/ENTRA-SYNCADMIN-001.ps1 -ConfirmReplacementAccounts
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
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
),

    [Parameter()]
    [string[]]$ExcludeUserId,

    [Parameter(Mandatory)]
    [switch]$ConfirmReplacementAccounts
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'RoleManagement.ReadWrite.Directory', 'User.Read.All'

$step = @{
    CheckId   = 'ENTRA-SYNCADMIN-001'
    Target    = 'Core admin roles held by synced accounts'
    Desired   = 'None'
    GetState  = {
        @(foreach ($roleId in $RoleDefinitionId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'&`$expand=principal" -OutputType HashTable)['value']) |
                Where-Object { $null -ne $_ -and $_['principal']['onPremisesSyncEnabled'] -eq $true -and @($ExcludeUserId) -notcontains $_['principalId'] } |
                ForEach-Object { [PSCustomObject]@{ AssignmentId = $_['id']; RoleDefinitionId = $roleId; UserPrincipalName = $_['principal']['userPrincipalName'] } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($a in $State) { Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/roleManagement/directory/roleAssignments/$($a.AssignmentId)" | Out-Null }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
