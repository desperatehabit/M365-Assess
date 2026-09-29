<#
.SYNOPSIS
    Worker entrypoint for the EPIC-032 audit search.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), runs
    the manual audit-log search (Search-AuditLog) or the directory-audits list
    (Get-AuditDirectory) live against Microsoft Graph and/or Purview, and
    emits the JSON envelope on stdout. Per-workload routing (SPEC §11.1): Graph
    directoryAudits/signIns for the directory and sign-in workloads, Purview
    audit search (Search-UnifiedAuditLog) for content workloads
    (Exchange/SharePoint/OneDrive). The worker connects Graph for every run and
    Exchange Online only when a requested workload routes to Purview. Results
    are ephemeral (§4.1): returned on stdout only and never written to disk;
    the only persistence is the audit event written through the -WriteAudit
    seam. Stdout is the response transport; the supervisor materializes the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'search' runs a manual audit-log search; 'directory' lists directory audits.
.PARAMETER Workload
    Workload filter for search runs without a job envelope.
.PARAMETER StartDate
    Optional window start for search runs without a job envelope.
.PARAMETER EndDate
    Optional window end for search runs without a job envelope.
.PARAMETER User
    Optional user filter for search runs without a job envelope.
.PARAMETER Activity
    Optional activity filter for search runs without a job envelope.
.PARAMETER Ip
    Optional IP filter for search runs without a job envelope.
.PARAMETER Category
    Optional category filter for directory runs without a job envelope.
.PARAMETER Top
    Maximum records returned.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/search-audit.ps1 -JobFile './run/audit-search-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/search-audit.ps1 -TenantId 'tenant-a' -Action 'search' -Workload 'Exchange'
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
    [ValidateSet('search', 'directory')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string[]]$Workload = @(),

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$StartDate = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$EndDate = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$User = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Activity = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Ip = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Category = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Search-AuditLog.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-AuditDirectory.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Graph is always required; Exchange
# Online (Purview audit search) only when a requested workload routes to it.
$tenantSession = $null
if ($JobFile) {
    $job = Read-AuditSearchJob -Path $JobFile
    $TenantId = $job['TenantId']
    $Action = $job['Action']
    $Workload = @($job['Workload'])
    $StartDate = $job['StartDate']
    $EndDate = $job['EndDate']
    $User = $job['User']
    $Activity = $job['Activity']
    $Ip = $job['Ip']
    $Category = $job['Category']
    if (-not $PSBoundParameters.ContainsKey('Top')) {
        $Top = $job['Top']
    }
}

$services = [System.Collections.Generic.List[string]]::new()
$services.Add('Graph')
$needsPurview = $false
if ($Action -eq 'search') {
    if (@($Workload).Count -eq 0) {
        $needsPurview = $true
    }
    else {
        foreach ($name in @($Workload)) {
            if ((Get-AuditSearchBackend -Workload $name) -eq 'Purview') {
                $needsPurview = $true
                break
            }
        }
    }
}
if ($needsPurview) {
    $services.Add('ExchangeOnline')
}

if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service $services
}
try {
    switch ($Action) {
        'search' {
            $result = Search-AuditLog -TenantId $TenantId -StartDate $StartDate -EndDate $EndDate -User $User -Activity $Activity -Workload $Workload -Ip $Ip -Top $Top
        }
        'directory' {
            $result = Get-AuditDirectory -TenantId $TenantId -Category $Category -StartDate $StartDate -EndDate $EndDate -Top $Top
        }
    }
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
