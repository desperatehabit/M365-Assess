<#
.SYNOPSIS
    Worker entrypoint for the EPIC-023 resource mailbox read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant id and kind
    directly), reads rooms, equipment, or room lists live from Exchange Online
    via Get-Resources, and emits the filtered cursor page as JSON on stdout.
    Room lists carry their membership. Stdout is the response transport;
    resource objects are never mirrored to disk. The supervisor connects EXO in
    this child process after materializing the tenant credential (T-0011)
    before invoking this script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Kind
    Resource kind: rooms, equipment, or roomlists.
.PARAMETER Search
    Case-insensitive substring match against name and primary SMTP.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-resources.ps1 -JobFile './run/resources-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-resources.ps1 -TenantId 'tenant-a' -Kind 'rooms'
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
    [ValidateSet('rooms', 'equipment', 'roomlists')]
    [string]$Kind,

    [Parameter()]
    [string]$Search = '',

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Resources.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-ResourcesJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Kind', 'Search', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $result = Get-Resources -TenantId $TenantId -Kind $Kind -Search $Search -Top $Top -Cursor $Cursor
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
