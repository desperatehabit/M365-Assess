<#
.SYNOPSIS
    Worker entrypoint for the EPIC-023 bulk contacts CSV import.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant and CSV/rows directly),
    imports the contacts live against Exchange Online via Invoke-ContactsImport,
    and emits the per-row result report as JSON on stdout. Valid rows are applied
    one at a time through the EPIC-006 gated contact executor and audited. The
    supervisor connects EXO in this child process after materializing the tenant
    credential before invoking this script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Csv
    Direct CSV body for runs without a job envelope.
.PARAMETER Rows
    Direct import rows for runs without a job envelope.
.PARAMETER Preview
    Report the intended import without writing to the tenant.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/import-contacts.ps1 -JobFile './run/contacts-import-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/import-contacts.ps1 -TenantId 'tenant-a' -Csv $csv
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
    [string]$Csv = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [object[]]$Rows = @(),

    [Parameter()]
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Import-Contacts.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-ContactAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    $Actor = ''
    $CorrelationId = ''
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-ContactsImportJob -Path $JobFile
        $TenantId = $job['TenantId']
        if (-not $PSBoundParameters.ContainsKey('Csv')) { $Csv = $job['Csv'] }
        if (-not $PSBoundParameters.ContainsKey('Rows')) { $Rows = $job['Rows'] }
        if (-not $PSBoundParameters.ContainsKey('Preview')) { $Preview = [bool]$job['Preview'] }
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $result = Invoke-ContactsImport -TenantId $TenantId -Rows $Rows -Csv $Csv -Preview:$Preview -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
