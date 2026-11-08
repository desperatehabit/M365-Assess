<#
.SYNOPSIS
    Worker entrypoint for EPIC-034 DNS recommendations.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a records JSON string directly),
    ranks the actionable recommendations for an analysed record set through
    Get-DnsRecommendations, and emits the recommendation array as JSON on
    stdout. The records are produced by the DNS analysis worker; this worker
    resolves nothing and writes nothing (SPEC §11.2).
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id (carried for the uniform job envelope).
.PARAMETER Records
    Direct record-set JSON for runs without a job envelope.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-dns-recommendations.ps1 -JobFile './run/dns-recs.json'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByRecords')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByRecords')]
    [ValidateNotNullOrEmpty()]
    [string]$Records
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-DnsRecommendations.ps1')

if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
    $job = Read-DnsRecommendationsJob -Path $JobFile
    $TenantId = $job['TenantId']
    $recordSet = $job['Records']
}
else {
    $recordSet = $Records | ConvertFrom-Json -AsHashtable
}

# -InputObject keeps `[]` on stdout when there are no recommendations:
# piping an empty array produces no output, which the BFF reads as a crash.
$result = @(Get-DnsRecommendations -Records $recordSet)
ConvertTo-Json -InputObject $result -Depth 6 -Compress
