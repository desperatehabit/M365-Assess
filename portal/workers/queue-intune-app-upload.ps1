<#
.SYNOPSIS
    Worker entrypoint for the EPIC-017 app upload queue (T-0323).
.DESCRIPTION
    Reads the job document the BFF's app upload runner writes, signs in to the job's
    tenant, creates the app and (for win32) uploads and commits its package, and prints
    the result as JSON. The BFF records state on the AppDeployment row from it.
.PARAMETER JobFile
    Path to the job document JSON written by the runner.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Queue-IntuneAppUpload.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-IntuneAppUploadJob -Path $JobFile
    $uploadParams = @{
        TenantId      = $job.TenantId
        DeploymentId  = $job.DeploymentId
        AppType       = $job.AppType
        App           = $job.App
        PackageUrl    = $job.PackageUrl
        PackageSize   = $job.PackageSize
        PackageSha256 = $job.PackageSha256
        ResumeAppId   = $job.ResumeAppId
        Actor         = $job.Actor
    }
    Invoke-IntuneAppUpload @uploadParams | ConvertTo-Json -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
