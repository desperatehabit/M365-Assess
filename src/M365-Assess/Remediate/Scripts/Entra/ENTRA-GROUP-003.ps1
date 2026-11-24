<#
.SYNOPSIS
    Remediates ENTRA-GROUP-003: Ensure that only organizationally managed/approved public groups exist
.DESCRIPTION
    Gives every ownerless public Microsoft 365 group an owner, or makes those groups private.

    Desired state: No public Microsoft 365 group without an owner
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Group.ReadWrite.All.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Action
    AddOwner: add -OwnerId as owner. MakePrivate: change visibility to Private.
.PARAMETER OwnerId
    Object ID of the user to add as owner (required with -Action AddOwner).
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-003.ps1 -Action AddOwner -OwnerId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-GROUP-003.ps1 -Action AddOwner -OwnerId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateSet('AddOwner', 'MakePrivate')]
    [string]$Action,

    [Parameter()]
    [string]$OwnerId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Group.ReadWrite.All'

$step = @{
    CheckId   = 'ENTRA-GROUP-003'
    Target    = 'Ownerless public Microsoft 365 groups'
    Desired   = 'None'
    GetState  = {
        @(@((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups?`$filter=groupTypes/any(c:c eq 'Unified')&`$select=id,displayName,visibility&`$top=999" -OutputType HashTable)['value']) |
            Where-Object { $null -ne $_ -and $_['visibility'] -eq 'Public' } |
            Where-Object { @((Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$($_['id'])/owners?`$select=id" -OutputType HashTable)['value']).Count -eq 0 } |
            ForEach-Object { [PSCustomObject]@{ Id = $_['id']; DisplayName = $_['displayName'] } })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        if ($Action -eq 'AddOwner' -and [string]::IsNullOrWhiteSpace($OwnerId)) { throw 'Pass -OwnerId with -Action AddOwner.' }
        foreach ($group in $State) {
            if ($Action -eq 'AddOwner') {
                Set-RemediationGraphObject -Uri "/v1.0/groups/$($group.Id)/owners/`$ref" -Method POST -Body @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$OwnerId" }
            }
            else {
                Set-RemediationGraphObject -Uri "/v1.0/groups/$($group.Id)" -Body @{ visibility = 'Private' }
            }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
