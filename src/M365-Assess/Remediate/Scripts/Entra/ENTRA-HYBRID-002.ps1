<#
.SYNOPSIS
    Remediates ENTRA-HYBRID-002: On-premises synced users holding Tier-0/1 Entra roles
.DESCRIPTION
    Removes Tier-0 and Tier-1 Entra role assignments from accounts synced from on-premises AD,
    so an on-premises compromise cannot reach cloud admin rights.

    Desired state: No synced account holds a Tier-0/1 role
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleManagement.ReadWrite.Directory, User.Read.All.

    Only direct (active) assignments are removed. PIM eligible assignments for synced accounts
    are listed in Before as well and should be removed in PIM.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RoleDefinitionId
    Tier-0 and Tier-1 role template IDs to change. Defaults to the Tier-0 and Tier-1 roles listed in the script.
.PARAMETER ExcludeUserId
    Synced accounts to leave as they are.
.PARAMETER ConfirmReplacementAccounts
    Confirms that cloud-only replacement admin accounts exist and hold these roles, so removing
    the synced accounts' roles does not leave the role unstaffed.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-HYBRID-002.ps1 -ConfirmReplacementAccounts -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-HYBRID-002.ps1 -ConfirmReplacementAccounts
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
    '8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2', # Hybrid Identity Administrator
    '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', # Application Administrator
    '158c047a-c907-4556-b7ef-446551a6b5f7', # Cloud Application Administrator
    '29232cdf-9323-42fd-ade2-1d097af3e4de', # Exchange Administrator
    'f28a1f50-f6e7-4571-818b-6a12f2af6b6c', # SharePoint Administrator
    'fe930be7-5e62-47db-91af-98c3a49a38b1', # User Administrator
    '3a2c62db-5318-420d-8d74-23affee5d9d5', # Intune Administrator
    'c4e39bd9-1100-46d3-8c65-fb160da0071f', # Authentication Administrator
    '729827e3-9c14-49f7-bb1b-9608f156bbb8', # Helpdesk Administrator
    'fdd7a751-b60b-444a-984c-02652fe8fa1c', # Groups Administrator
    '69091246-20e8-4a56-aa4d-066075b2a7a8' # Teams Administrator
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
    CheckId   = 'ENTRA-HYBRID-002'
    Target    = 'Tier-0/1 role assignments held by synced accounts'
    Desired   = 'None'
    GetState  = {
        @(foreach ($roleId in $RoleDefinitionId) {
            @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '$roleId'&`$expand=principal" -OutputType HashTable)['value']) |
                Where-Object { $null -ne $_ -and $_['principal']['onPremisesSyncEnabled'] -eq $true -and @($ExcludeUserId) -notcontains $_['principalId'] } |
                ForEach-Object { [PSCustomObject]@{ AssignmentId = $_['id']; RoleDefinitionId = $roleId; PrincipalId = $_['principalId']; UserPrincipalName = $_['principal']['userPrincipalName'] } }
        })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($assignment in $State) {
            Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/roleManagement/directory/roleAssignments/$($assignment.AssignmentId)" | Out-Null
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
