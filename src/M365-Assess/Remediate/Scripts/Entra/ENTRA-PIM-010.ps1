<#
.SYNOPSIS
    Remediates ENTRA-PIM-010: No admin notification on Tier-0 role activation
.DESCRIPTION
    Sends an email to the addresses you choose whenever a Tier-0 role is activated.

    Desired state: PIM rule updated for each role
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: RoleManagementPolicy.ReadWrite.Directory.

    Requires Entra ID P2 (PIM).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER RoleDefinitionId
    Tier-0 role template IDs to change. Defaults to the Tier-0 roles listed in the script.
.PARAMETER NotifyAddress
    Email addresses to notify (security team mailbox).
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-010.ps1 -NotifyAddress 'secops@contoso.com' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-PIM-010.ps1 -NotifyAddress 'secops@contoso.com'
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
    '158c047a-c907-4556-b7ef-446551a6b5f7' # Cloud Application Administrator
),

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$NotifyAddress
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'RoleManagementPolicy.ReadWrite.Directory'

$step = @{
    CheckId   = 'ENTRA-PIM-010'
    Target    = "PIM rule Notification_Admin_EndUser_Assignment for roles: $($RoleDefinitionId -join ', ')"
    Desired   = 'Updated'
    GetState  = {
        @(foreach ($roleId in $RoleDefinitionId) {
            $rule = Get-RemediationPimRule -RoleDefinitionId $roleId -RuleId 'Notification_Admin_EndUser_Assignment'
            $rule['roleDefinitionId'] = $roleId
            $rule
        })
    }
    TestState = {
        param($State)
        @($State | Where-Object { $rule = $_; -not (@($NotifyAddress | Where-Object { @($rule['notificationRecipients']) -notcontains $_ }).Count -eq 0) }).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($rule in @($State | Where-Object { $rule = $_; -not (@($NotifyAddress | Where-Object { @($rule['notificationRecipients']) -notcontains $_ }).Count -eq 0) })) {
            $current = @{}
            foreach ($key in $rule.Keys) { if ($key -ne 'roleDefinitionId') { $current[$key] = $rule[$key] } }
            Set-RemediationPimRule -Current $current -Changes (@{ notificationLevel = 'All'; isDefaultRecipientsEnabled = $true; notificationRecipients = @(@($rule['notificationRecipients']) + $NotifyAddress | Where-Object { $_ } | Sort-Object -Unique) })
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
