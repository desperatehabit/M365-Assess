<#
.SYNOPSIS
    Worker entrypoint for EPIC-017 app detail, update, and delete (T-0843).
.DESCRIPTION
    Reads the job document, signs in to the job's tenant, and reads one app or previews /
    applies an update or delete. Prints the result as JSON.
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

# Queue-IntuneAppUpload supplies the portal -> Graph detection-rule mapping.
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Queue-IntuneAppUpload.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-IntuneApp.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-IntuneAppJob -Path $JobFile
    $result = if ($job['action'] -eq 'get') {
        Get-IntuneAppDetail -AppId ([string]$job['appId'])
    }
    else {
        $changeParams = @{
            TenantId    = [string]$job['tenantId']
            AppId       = [string]$job['appId']
            Action      = [string]$job['action']
            Changes     = if ($job['changes']) { $job['changes'] } else { @{} }
            ConfirmName = [string]$job['confirmName']
            Preview     = [bool]($job['preview'] -eq $true)
            Actor       = if ($job['actor']) { [string]$job['actor'] } else { 'system' }
            Confirm     = $false
        }
        Invoke-IntuneAppChange @changeParams
    }
    ConvertTo-Json -InputObject $result -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
