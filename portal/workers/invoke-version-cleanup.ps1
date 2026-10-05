# invoke-version-cleanup.ps1 — worker entrypoint for EPIC-025 version cleanup (T-0487).
#
# Emits the Invoke-VersionCleanup response object as JSON on stdout. The BFF
# runs it with -JobFile (tenantId, siteId, ageThresholdDays, includeVersions,
# excludeVersions, mode, confirmCount, actor, correlationId, and the credential
# block for Connect-WorkerTenant, T-0826); direct parameters remain for manual
# runs that manage their own session. Plan is the default: a job that omits the
# mode does not write.

[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$SiteId,

    [Parameter(ParameterSetName = 'ByParams')]
    [ValidateRange(0, 3650)]
    [int]$AgeThresholdDays = 90,

    [Parameter(ParameterSetName = 'ByParams')]
    [string[]]$IncludeVersions = @(),

    [Parameter(ParameterSetName = 'ByParams')]
    [string[]]$ExcludeVersions = @(),

    [Parameter(ParameterSetName = 'ByParams')]
    [ValidateSet('Plan', 'Apply')]
    [string]$Mode = 'Plan',

    [Parameter(ParameterSetName = 'ByParams')]
    [int]$ConfirmCount = -1,

    [Parameter()]
    [string]$Actor = '',

    [Parameter()]
    [string]$CorrelationId = '',

    [Parameter()]
    [string]$JobId = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-VersionCleanup.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
    $TenantId = [string]$job.tenantId
    $SiteId = [string]$job.siteId
    if (-not $TenantId) { throw "job envelope '$JobFile' is missing 'tenantId'" }
    if (-not $SiteId) { throw "job envelope '$JobFile' is missing 'siteId'" }
    # Optional fields are absent from the envelope when the adapter omits them;
    # under StrictMode a missing property throws, so read them through a helper.
    $jobField = { param([string]$Name) $prop = $job.PSObject.Properties[$Name]; if ($prop) { $prop.Value } else { $null } }
    $value = & $jobField 'ageThresholdDays'
    if ($null -ne $value) { $AgeThresholdDays = [int]$value }
    $value = & $jobField 'includeVersions'
    if ($null -ne $value) { $IncludeVersions = @($value) }
    $value = & $jobField 'excludeVersions'
    if ($null -ne $value) { $ExcludeVersions = @($value) }
    $value = & $jobField 'mode'
    if ($value) { $Mode = [string]$value }
    $value = & $jobField 'confirmCount'
    if ($null -ne $value) { $ConfirmCount = [int]$value }
    $value = & $jobField 'actor'
    if ($value) { $Actor = [string]$value }
    $value = & $jobField 'correlationId'
    if ($value) { $CorrelationId = [string]$value }
    $value = & $jobField 'jobId'
    if ($value) { $JobId = [string]$value }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $params = @{
        TenantId         = $TenantId
        SiteId           = $SiteId
        AgeThresholdDays = $AgeThresholdDays
        Mode             = $Mode
    }
    if ($IncludeVersions.Count -gt 0) { $params['IncludeVersions'] = $IncludeVersions }
    if ($ExcludeVersions.Count -gt 0) { $params['ExcludeVersions'] = $ExcludeVersions }
    if ($ConfirmCount -ge 0) { $params['ConfirmCount'] = $ConfirmCount }
    if ($Actor) { $params['Actor'] = $Actor }
    if ($CorrelationId) { $params['CorrelationId'] = $CorrelationId }
    if ($JobId) { $params['JobId'] = $JobId }
    $result = Invoke-VersionCleanup @params
    $result | ConvertTo-Json -Depth 12 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
