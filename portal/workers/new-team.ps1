<#
.SYNOPSIS
    Worker entrypoint for the EPIC-026 team create.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a planned team directly),
    expands an optional local TeamTemplate, applies the create live against
    Graph via New-Team, and emits the result envelope as JSON on stdout.
    Stdout is the response transport. The supervisor connects Graph in this
    child process after materializing the tenant credential (T-0011) before
    invoking this script, so no secret handling lives here. -DryRun plans the
    create with no tenant write.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER TeamJson
    Planned team as a JSON object (direct mode).
.PARAMETER TemplateJson
    Optional stored TeamTemplate as a JSON object (direct mode).
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Actor
    Caller identity recorded on the audit event and TeamOperation.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/new-team.ps1 -JobFile './run/team-create-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/new-team.ps1 -TenantId 'tenant-a' -TeamJson '{"name":"Project Alpha","owners":["owner@example.invalid"],"visibility":"private"}' -DryRun
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
    [string]$TeamJson = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$TemplateJson = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [string]$Actor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/New-Team.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $template = $null
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-TeamCreateJob -Path $JobFile
        $TenantId = $job['TenantId']
        $team = $job['Team']
        $template = $job['Template']
        $Actor = $job['Actor']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }
    else {
        if ($TeamJson.Trim().Length -eq 0) {
            throw 'Team create needs -TeamJson in direct mode.'
        }
        $team = $TeamJson | ConvertFrom-Json
        if ($TemplateJson.Trim().Length -gt 0) {
            $template = $TemplateJson | ConvertFrom-Json
        }
    }

    $result = New-Team -TenantId $TenantId -Team $team -Template $template -DryRun:$DryRun -Actor $Actor
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
