<#
.SYNOPSIS
    Worker entrypoint for the EPIC-028 incident triage actions.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant, incident, and
    action directly), executes the triage action live against Graph via
    Invoke-IncidentAction, and emits the result as JSON on stdout. Stdout is
    the response transport. The supervisor connects Graph in this child
    process after materializing the tenant credential (T-0011) before
    invoking this script, so no secret handling lives here. -DryRun plans
    the action with no tenant write; resolving an incident additionally
    requires -Confirm so a change can never silently auto-resolve.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER IncidentId
    Direct target incident id for runs without a job envelope.
.PARAMETER Action
    Triage action: assign, status, classify, or comment.
.PARAMETER Value
    New status, classification, or assignee for assign/status/classify.
.PARAMETER Comment
    Comment body for the comment action.
.PARAMETER Reason
    Triage reason recorded on the audit event and state change.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirm
    Explicit confirmation; mandatory when the action resolves the incident.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-incident-action.ps1 -JobFile './run/incident-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-incident-action.ps1 -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -Confirm -Reason 'Handled'
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
    [string]$IncidentId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Value = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Comment = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Reason = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirm
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-IncidentAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-IncidentActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $IncidentId = $job['IncidentId']
        $Action = $job['Action']
        $Value = $job['Value']
        $Comment = $job['Comment']
        $Reason = $job['Reason']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirm')) {
            $Confirm = [bool]$job['Confirmed']
        }
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $result = Invoke-IncidentAction -TenantId $TenantId -IncidentId $IncidentId -Action $Action -Value $Value -Comment $Comment -Reason $Reason -DryRun:$DryRun -Confirmed:$Confirm -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
