<#
.SYNOPSIS
    Remediates INTUNE-INVENTORY-001: Ensure Intune serves as authoritative device inventory with categories
.DESCRIPTION
    Creates the Intune device categories you name, so devices can be grouped in the inventory.

    Desired state: Each -CategoryName exists
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementManagedDevices.ReadWrite.All.

    Devices also need to be enrolled; users pick a category on enrollment, or you can set it on
    the device. Dynamic groups can use deviceCategory.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER CategoryName
    Category names, e.g. 'Corporate laptop', 'Kiosk', 'Shared'.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-INVENTORY-001.ps1 -CategoryName 'Corporate laptop', 'Kiosk' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-INVENTORY-001.ps1 -CategoryName 'Corporate laptop', 'Kiosk'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$CategoryName
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementManagedDevices.ReadWrite.All'

$step = @{
    CheckId   = 'INTUNE-INVENTORY-001'
    Target    = 'Intune device categories'
    Desired   = 'Created'
    GetState  = {
        $existing = @(@((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceCategories' -OutputType HashTable)['value']) | Where-Object { $_ } | ForEach-Object { $_['displayName'] })
        @($CategoryName | Where-Object { $existing -notcontains $_ })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($name in $State) { Set-RemediationGraphObject -Uri '/beta/deviceManagement/deviceCategories' -Method POST -Body @{ displayName = $name; description = $name } }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
