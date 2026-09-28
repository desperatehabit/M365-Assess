<#
.SYNOPSIS
    Worker entrypoint for EPIC-017 application template deploy preflight (T-0327).
.DESCRIPTION
    Reads the job document, signs in to the job's tenant, substitutes the template's
    variables, checks for an existing app of the same name, and prints the result as JSON.
    Read-only: the BFF queues the resolved upload.
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

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Deploy-ApplicationTemplate.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-ApplicationTemplateJob -Path $JobFile
    Invoke-ApplicationTemplatePreflight -TenantId $job.TenantId -Config $job.Config -Values $job.Values |
        ConvertTo-Json -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
