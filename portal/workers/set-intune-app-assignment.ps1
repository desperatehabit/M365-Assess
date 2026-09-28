<#
.SYNOPSIS
    Worker entrypoint for EPIC-017 app assignment (T-0324).
.DESCRIPTION
    Reads the job document, signs in to the job's tenant, and previews or applies the
    app's assignment plan. Prints the result as JSON.
.PARAMETER JobFile
    Path to the job document JSON written by the BFF.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-IntuneAppAssignment.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-IntuneAppAssignmentJob -Path $JobFile
    $assignParams = @{
        TenantId    = $job.TenantId
        AppId       = $job.AppId
        Assignments = $job.Assignments
        Mode        = $job.Mode
        Preview     = $job.Preview
        ConfirmPlan = $job.ConfirmPlan
        Actor       = $job.Actor
        Confirm     = $false
    }
    Set-IntuneAppAssignment @assignParams | ConvertTo-Json -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
