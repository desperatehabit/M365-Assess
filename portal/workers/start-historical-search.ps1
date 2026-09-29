<#
.SYNOPSIS
    Worker entrypoint for the EPIC-024 historical search.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), runs
    the compliance-search job live against Exchange Online via
    Start-HistoricalSearch (start), Get-HistoricalSearchResult (poll), or
    Stop-HistoricalSearch (cancel), and emits the JSON envelope on stdout.
    Stdout is the response transport; matches and the download reference are
    returned only — message data is never mirrored to disk (SPEC §11.4). The
    supervisor connects EXO in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here. Progress events flow on stderr; audit records flow to
    the app audit sink through the -WriteAudit seam.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'start' creates and starts the compliance search; 'poll' reports progress
    or completion; 'cancel' stops the in-flight search.
.PARAMETER JobId
    Direct historical-search job id for runs without a job envelope.
.PARAMETER Query
    Direct KQL content-match query for start runs without a job envelope.
.PARAMETER ExchangeLocation
    Direct mailbox scope for start runs without a job envelope.
.PARAMETER StartDate
    Optional window start for start runs without a job envelope.
.PARAMETER EndDate
    Optional window end for start runs without a job envelope.
.PARAMETER Top
    Maximum matches returned by poll runs.
.PARAMETER SearchName
    Direct compliance-search name for poll and cancel runs without a job envelope.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/start-historical-search.ps1 -JobFile './run/historical-search-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/start-historical-search.ps1 -TenantId 'tenant-a' -Action 'start' -JobId 'job-1' -Query 'subject:invoice'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateSet('start', 'poll', 'cancel')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$JobId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Query = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string[]]$ExchangeLocation = @(),

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$StartDate = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$EndDate = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$SearchName = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Start-HistoricalSearch.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-HistoricalSearchJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Action = $job['Action']
        $JobId = $job['JobId']
        $SearchName = $job['SearchName']
        if (-not $PSBoundParameters.ContainsKey('Top')) {
            $Top = $job['Top']
        }
        if ($Action -eq 'start') {
            $Query = $job['Query']
            $ExchangeLocation = $job['ExchangeLocation']
            $StartDate = $job['StartDate']
            $EndDate = $job['EndDate']
        }
    }

    if ([string]::IsNullOrWhiteSpace($JobId)) {
        throw "historical-search.invalid_job_id: a job id is required"
    }
    if ($Action -ne 'start' -and [string]::IsNullOrWhiteSpace($SearchName)) {
        $SearchName = New-HistoricalSearchName -JobId $JobId
    }

    switch ($Action) {
        'start' {
            $result = Start-HistoricalSearch -TenantId $TenantId -JobId $JobId -Query $Query -ExchangeLocation $ExchangeLocation -StartDate $StartDate -EndDate $EndDate
        }
        'poll' {
            $result = Get-HistoricalSearchResult -TenantId $TenantId -JobId $JobId -SearchName $SearchName -Top $Top
        }
        'cancel' {
            $result = Stop-HistoricalSearch -TenantId $TenantId -JobId $JobId -SearchName $SearchName
        }
    }
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
