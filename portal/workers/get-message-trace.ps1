<#
.SYNOPSIS
    Worker entrypoint for the EPIC-024 message trace query.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant id plus trace
    filters directly), traces messages live from Exchange Online via
    Get-MessageTrace, and emits the cursor page as JSON on stdout. The date
    range is validated against the EXO trace window before the read; a range
    beyond the window surfaces as a structured error naming the limit.
    Stdout is the response transport; message data is never mirrored to disk.
    The supervisor connects EXO in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER SenderAddress
    Exact sender address filter for runs without a job envelope.
.PARAMETER RecipientAddress
    Exact recipient address filter for runs without a job envelope.
.PARAMETER Subject
    Substring subject filter for runs without a job envelope.
.PARAMETER Status
    Exact status filter for runs without a job envelope.
.PARAMETER StartDate
    Window start for runs without a job envelope.
.PARAMETER EndDate
    Window end for runs without a job envelope.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-message-trace.ps1 -JobFile './run/message-trace-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-message-trace.ps1 -TenantId 'tenant-a' -Subject 'invoice' -Top 50
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$SenderAddress = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$RecipientAddress = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Subject = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Status = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$StartDate = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$EndDate = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-MessageTrace.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-MessageTraceJob -Path $JobFile
        $TenantId = $job['TenantId']
        $SenderAddress = $job['SenderAddress']
        $RecipientAddress = $job['RecipientAddress']
        $Subject = $job['Subject']
        $Status = $job['Status']
        $StartDate = $job['StartDate']
        $EndDate = $job['EndDate']
        if (-not $PSBoundParameters.ContainsKey('Top')) {
            $Top = $job['Top']
        }
        if (-not $PSBoundParameters.ContainsKey('Cursor')) {
            $Cursor = $job['Cursor']
        }
    }

    $result = Get-MessageTrace -TenantId $TenantId -SenderAddress $SenderAddress -RecipientAddress $RecipientAddress -Subject $Subject -Status $Status -StartDate $StartDate -EndDate $EndDate -Top $Top -Cursor $Cursor
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
