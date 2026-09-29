<#
.SYNOPSIS
    Worker entrypoint for the EPIC-030 Safe Links policy read and gated change.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), reads
    Safe Links policies live from Exchange Online via Get-SafeLinksPolicies or
    applies a gated change via Invoke-SafeLinksPolicyChange, and emits the JSON
    envelope on stdout. The supervisor connects EXO in this child process after
    materializing the tenant credential (T-0011) before invoking this script,
    so no secret handling lives here. One job runs in one child process for
    one tenant, so an EXO session is never shared across tenants. -DryRun
    plans with no tenant write; apply requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'list' reads policies; create/edit/enable/disable/delete apply a gated change.
.PARAMETER PolicyId
    Direct Safe Links policy identity for change runs without a job envelope.
.PARAMETER Name
    Direct policy name for create runs without a job envelope.
.PARAMETER Settings
    Direct planned settings (isEnabled, urlRewriting, scanOnClick, detonation)
    for create and edit runs without a job envelope.
.PARAMETER ConfirmName
    Direct delete confirmation name for delete runs without a job envelope.
.PARAMETER Search
    Case-insensitive substring match against the policy name.
.PARAMETER State
    Filter by policy state: enabled, disabled, or empty for all.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-safelinks.ps1 -JobFile './run/safelinks-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-safelinks.ps1 -TenantId 'tenant-a' -Action 'disable' -PolicyId 'policy-1' -Confirmed
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
    [ValidateSet('list', 'create', 'edit', 'enable', 'disable', 'delete')]
    [string]$Action = 'list',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$PolicyId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Name = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [hashtable]$Settings = @{},

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ConfirmName = '',

    [Parameter()]
    [string]$Search = '',

    [Parameter()]
    [ValidateSet('', 'enabled', 'disabled')]
    [string]$State = '',

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-SafeLinks.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SafeLinksJob -Path $JobFile
        $TenantId    = $job['TenantId']
        $Action      = $job['Action']
        $PolicyId    = $job['PolicyId']
        $Name        = $job['Name']
        $Settings    = $job['Settings']
        $ConfirmName = $job['ConfirmName']
        foreach ($name in @('Search', 'State', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    if ($Action -eq 'list') {
        $invokeParams = @{
            TenantId = $TenantId
            Search   = $Search
            State    = $State
            Top      = $Top
            Cursor   = $Cursor
        }
        $result = Get-SafeLinksPolicies @invokeParams
    }
    else {
        $invokeParams = @{
            TenantId    = $TenantId
            Action      = $Action
            PolicyId    = $PolicyId
            Name        = $Name
            Settings    = $Settings
            ConfirmName = $ConfirmName
            DryRun      = [bool]$DryRun
            Confirmed   = [bool]$Confirmed
        }
        $result = Invoke-SafeLinksPolicyChange @invokeParams
    }

    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
