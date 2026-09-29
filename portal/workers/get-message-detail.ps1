<#
.SYNOPSIS
    Worker entrypoint for the EPIC-024 message viewer read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant id plus message id
    directly), reads the message detail live from Exchange Online via
    Get-MessageDetail, and emits it as JSON on stdout. The body is included
    only with -IncludeBody, which the BFF passes solely for callers holding
    mailtools.content; otherwise the response reports the body as gated.
    Stdout is the response transport; message data is never mirrored to disk.
    The supervisor connects EXO in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER MessageId
    Direct message identity for runs without a job envelope.
.PARAMETER IncludeBody
    Fetch the privileged message body. Only the BFF sets this, and only for
    callers holding mailtools.content.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-message-detail.ps1 -JobFile './run/message-detail-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-message-detail.ps1 -TenantId 'tenant-a' -MessageId '<id>'
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
    [ValidateNotNullOrEmpty()]
    [string]$MessageId,

    [Parameter()]
    [switch]$IncludeBody
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-MessageDetail.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-MessageDetailJob -Path $JobFile
        $TenantId = $job['TenantId']
        $MessageId = $job['MessageId']
        if (-not $PSBoundParameters.ContainsKey('IncludeBody')) {
            $IncludeBody = [bool]$job['IncludeBody']
        }
    }

    $result = Get-MessageDetail -TenantId $TenantId -MessageId $MessageId -IncludeBody:$IncludeBody
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
