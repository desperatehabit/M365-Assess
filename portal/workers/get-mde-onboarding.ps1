<#
.SYNOPSIS
    Worker entrypoint for EPIC-019 MDE onboarding coverage.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    computes onboarded vs total devices per platform from EPIC-018 device
    records plus the T-0361 Defender state via Get-MdeOnboarding, and emits
    JSON on stdout. The worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER Platform
    Optional single platform (windows, macos, ios, android, linux, other).
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter()]
    [ValidateSet('', 'windows', 'macos', 'ios', 'android', 'linux', 'other')]
    [string]$Platform = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-MdeOnboarding.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-MdeOnboardingJob -Path $JobFile
        $TenantId = $job['TenantId']
        if (-not $PSBoundParameters.ContainsKey('Platform') -and $job.ContainsKey('Platform')) {
            Set-Variable -Name Platform -Value $job['Platform']
        }
    }

    $result = Get-MdeOnboarding -TenantId $TenantId -Platform $Platform
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
