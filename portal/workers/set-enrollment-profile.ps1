<#
.SYNOPSIS
    Worker entrypoint for EPIC-017 enrollment profiles (T-0329).
.DESCRIPTION
    Reads the job document, signs in to the job's tenant, and lists enrollment profiles with
    token status, or previews/applies a profile create, update, delete, or Apple device
    assignment. Prints the result as JSON; enrollment secrets never appear in it.
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

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-EnrollmentProfile.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-EnrollmentProfileJob -Path $JobFile
    $result = if ($job['action'] -eq 'list') {
        Get-EnrollmentProfiles -TenantId ([string]$job['tenantId'])
    }
    else {
        $writeParams = @{
            TenantId               = [string]$job['tenantId']
            Action                 = [string]$job['action']
            Platform               = [string]$job['platform']
            DepOnboardingSettingId = [string]$job['depOnboardingSettingId']
            ProfileId              = [string]$job['profileId']
            ProfileBody            = if ($job['profile']) { $job['profile'] } else { @{} }
            SerialNumbers          = @($job['serialNumbers'] | Where-Object { $_ } | ForEach-Object { [string]$_ })
            ConfirmName            = [string]$job['confirmName']
            Preview                = [bool]($job['preview'] -eq $true)
            Actor                  = if ($job['actor']) { [string]$job['actor'] } else { 'system' }
            Confirm                = $false
        }
        Invoke-EnrollmentProfileWrite @writeParams
    }
    ConvertTo-Json -InputObject $result -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
