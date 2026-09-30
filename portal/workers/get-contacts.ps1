<#
.SYNOPSIS
    Worker entrypoint for the EPIC-023 contacts list read.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant id directly),
    reads the contacts live from Exchange Online via Get-Contacts, and emits
    the filtered cursor page as JSON on stdout. Stdout is the response transport;
    contact objects are never mirrored to disk. The supervisor connects EXO in
    this child process after materializing the tenant credential before invoking
    this script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Search
    Case-insensitive substring match against display name and external address.
.PARAMETER Type
    Filter by contact type: mailContact or mailUser.
.PARAMETER Hidden
    'true' keeps hidden contacts, 'false' the rest, empty both.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-contacts.ps1 -JobFile './run/contacts-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-contacts.ps1 -TenantId 'tenant-a' -Type 'mailContact'
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
    [string]$Search = '',

    [Parameter()]
    [ValidateSet('', 'mailContact', 'mailUser')]
    [string]$Type = '',

    [Parameter()]
    [ValidateSet('', 'true', 'false')]
    [string]$Hidden = '',

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Contacts.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-ContactsJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Search', 'Type', 'Hidden', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $result = Get-Contacts -TenantId $TenantId -Search $Search -Type $Type -Hidden $Hidden -Top $Top -Cursor $Cursor
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
