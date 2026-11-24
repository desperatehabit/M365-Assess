<#
.SYNOPSIS
    Remediates ENTRA-CLOUDADMIN-002: Ensure administrative accounts use licenses with a reduced application footprint
.DESCRIPTION
    Removes productivity licenses (the SKUs you list, such as E3/E5) from Global Administrator
    accounts so admin accounts have a minimal application footprint.

    Desired state: No Global Administrator has the listed SKUs directly assigned
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: User.ReadWrite.All, RoleManagement.Read.Directory.

    Removing a license deletes the mailbox and OneDrive after the grace period if the account
    has them. Licenses assigned through groups are not removed; take the admin out of the group.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SkuId
    SKU IDs to remove (from Get-MgSubscribedSku), e.g. the E3 / E5 SKUs.
.PARAMETER ExcludeUserId
    Admins to leave as they are.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CLOUDADMIN-002.ps1 -SkuId '06ebc4ee-1bb5-47dd-8120-11324bc54e06' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CLOUDADMIN-002.ps1 -SkuId '06ebc4ee-1bb5-47dd-8120-11324bc54e06'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$SkuId,

    [Parameter()]
    [string[]]$ExcludeUserId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'User.ReadWrite.All', 'RoleManagement.Read.Directory'

$step = @{
    CheckId   = 'ENTRA-CLOUDADMIN-002'
    Target    = 'Global Administrators with productivity licenses'
    Desired   = 'None'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/roleManagement/directory/roleAssignments?`$filter=roleDefinitionId eq '62e90394-69f5-4237-9190-012177145e10'&`$expand=principal" -OutputType HashTable)['value']) | Where-Object { $null -ne $_ -and @($ExcludeUserId) -notcontains $_['principalId'] } |
            ForEach-Object {
                $user = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/users/$($_['principalId'])?`$select=id,userPrincipalName,licenseAssignmentStates" -OutputType HashTable -ErrorAction SilentlyContinue
                $direct = @($user['licenseAssignmentStates'] | Where-Object { $null -eq $_['assignedByGroup'] -and @($SkuId) -contains $_['skuId'] } | ForEach-Object { $_['skuId'] })
                if ($direct.Count -gt 0) { [PSCustomObject]@{ Id = $user['id']; UserPrincipalName = $user['userPrincipalName']; SkuIds = $direct } }
            })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($admin in $State) {
            Set-RemediationGraphObject -Uri "/v1.0/users/$($admin.Id)/assignLicense" -Method POST -Body @{ addLicenses = @(); removeLicenses = @($admin.SkuIds) }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
