<#
.SYNOPSIS
    Worker entrypoint for EPIC-017 Autopilot deployment profile writes (T-0845).
.DESCRIPTION
    Reads the job document, signs in to the job's tenant, and previews or applies a profile
    create, update, delete, or group assignment change. Prints the result as JSON.
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

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-AutopilotProfile.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-AutopilotProfileJob -Path $JobFile
    $writeParams = @{
        TenantId       = [string]$job['tenantId']
        Action         = [string]$job['action']
        ProfileId      = [string]$job['profileId']
        ProfileBody    = if ($job['profile']) { $job['profile'] } else { @{} }
        AddGroupIds    = @($job['addGroupIds'] | Where-Object { $_ } | ForEach-Object { [string]$_ })
        RemoveGroupIds = @($job['removeGroupIds'] | Where-Object { $_ } | ForEach-Object { [string]$_ })
        ConfirmName    = [string]$job['confirmName']
        Preview        = [bool]($job['preview'] -eq $true)
        Actor          = if ($job['actor']) { [string]$job['actor'] } else { 'system' }
        Confirm        = $false
    }
    ConvertTo-Json -InputObject (Invoke-AutopilotProfileWrite @writeParams) -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
