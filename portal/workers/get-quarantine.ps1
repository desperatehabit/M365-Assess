<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 quarantine list and detail read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or direct parameters), reads
    quarantined messages live from Exchange Online via Get-Quarantine, and emits
    the JSON result on stdout. Stdout is the response transport; quarantine
    messages are never mirrored to disk. The supervisor connects EXO in this
    child process after materializing the tenant credential before invoking
    this script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER MessageId
    Optional message identity for single-message preview mode.
.PARAMETER Tab
    Quarantine tab: email, files, or teams.
.PARAMETER Reason
    Optional quarantine reason filter.
.PARAMETER Direction
    Optional direction filter.
.PARAMETER Recipient
    Optional recipient filter.
.PARAMETER State
    Optional release state filter.
.PARAMETER DateFrom
    Optional inclusive start timestamp filter.
.PARAMETER DateTo
    Optional inclusive end timestamp filter.
.PARAMETER Cursor
    Optional pagination cursor.
.PARAMETER Limit
    Page size for list mode (1..1000, default 50).
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-quarantine.ps1 -JobFile './run/quarantine-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-quarantine.ps1 -TenantId 'tenant-a' -Tab 'email'
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
    [string]$MessageId = '',

    [Parameter()]
    [string]$Tab = 'email',

    [Parameter()]
    [string]$Reason = '',

    [Parameter()]
    [string]$Direction = '',

    [Parameter()]
    [string]$Recipient = '',

    [Parameter()]
    [string]$State = '',

    [Parameter()]
    [string]$DateFrom = '',

    [Parameter()]
    [string]$DateTo = '',

    [Parameter()]
    [string]$Cursor = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Limit = 50
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Quarantine.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-QuarantineJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('MessageId', 'Tab', 'Reason', 'Direction', 'Recipient', 'State', 'DateFrom', 'DateTo', 'Cursor', 'Limit')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId  = $TenantId
        MessageId = $MessageId
        Tab       = $Tab
        Reason    = $Reason
        Direction = $Direction
        Recipient = $Recipient
        State     = $State
        DateFrom  = $DateFrom
        DateTo    = $DateTo
        Cursor    = $Cursor
        Limit     = $Limit
    }

    $result = Get-Quarantine @invokeParams
    if ($null -eq $result) {
        Write-Output -InputObject 'null'
    }
    else {
        $result | ConvertTo-Json -Depth 8 -Compress
    }
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
