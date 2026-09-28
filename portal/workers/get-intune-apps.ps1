# get-intune-apps.ps1 - entrypoint for Get-IntuneApps worker (T-0321).
# Dot-sources the worker module and dispatches to Get-IntuneApps.

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$JobFile
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-IntuneApps.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-IntuneAppsJob -Path $JobFile
    $listParams = @{
        TenantId = $job.TenantId
        View     = $job.View
        AppType  = $job.AppType
        Assigned = $job.Assigned
        Search   = $job.Search
        Top      = $job.Top
        Cursor   = $job.Cursor
    }
    Get-IntuneApps @listParams | ConvertTo-Json -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
