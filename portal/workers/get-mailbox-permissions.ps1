<#
.SYNOPSIS
    Worker entrypoint for the EPIC-027 mailbox/calendar permission report read.
.DESCRIPTION
    Reads a feature job envelope from -JobFile (tenant id, scope, search, and
    pagination fields), reads the permissions live from Exchange Online via
    Get-MailboxPermissions, and emits the cursor page as JSON on stdout. With
    -TenantId the report is read directly for manual runs that manage their own
    session. Stdout is the response transport; mailbox objects are never
    mirrored to disk. The supervisor connects EXO in this child process after
    materializing the tenant credential (T-0011) before invoking this script,
    so no secret handling lives here. Read-only: only Get- cmdlets are issued.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Scope
    'mailbox' or 'calendar' restricts the report to one permission family;
    empty returns both.
.PARAMETER Search
    Case-insensitive substring match against mailbox display name, primary
    SMTP, and principal.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-mailbox-permissions.ps1 -JobFile './run/mailbox-permissions-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-mailbox-permissions.ps1 -TenantId 'tenant-a' -Scope 'calendar'
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
    [ValidateSet('', 'mailbox', 'calendar')]
    [string]$Scope = '',

    [Parameter()]
    [string]$Search = '',

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-MailboxPermissions.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $job = Read-MailboxPermissionsJob -Path $JobFile
    $TenantId = $job['TenantId']
    foreach ($name in @('Scope', 'Search', 'Top', 'Cursor')) {
        if (-not $PSBoundParameters.ContainsKey($name)) {
            Set-Variable -Name $name -Value $job[$name]
        }
    }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    $result = Get-MailboxPermissions -TenantId $TenantId -Scope $Scope -Search $Search -Top $Top -Cursor $Cursor
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
