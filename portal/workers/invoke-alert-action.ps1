<#
.SYNOPSIS
    Worker entrypoint for the EPIC-028 alert triage actions.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant, alert, and action
    directly), executes the triage action live against Graph via
    Invoke-AlertAction, and emits the result as JSON on stdout. Stdout is the
    response transport. The supervisor connects Graph in this child process
    after materializing the tenant credential (T-0011) before invoking this
    script, so no secret handling lives here. -DryRun plans the action with no
    tenant write; resolving an alert or creating an incident additionally
    requires -Confirm so a change can never silently auto-resolve or open an
    incident.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER AlertId
    Direct target alert id for runs without a job envelope.
.PARAMETER Action
    Triage action: status, assign, comment, or create-incident.
.PARAMETER Value
    New status, assignee, or incident title for status/assign/create-incident.
.PARAMETER Comment
    Comment body for the comment action.
.PARAMETER Reason
    Triage reason recorded on the audit event and state change.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirm
    Explicit confirmation; mandatory when the action resolves the alert or
    creates an incident.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-alert-action.ps1 -JobFile './run/alert-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-alert-action.ps1 -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'resolved' -Confirm -Reason 'Handled'
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
    [string]$AlertId,

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

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-AlertAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-AlertActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $AlertId = $job['AlertId']
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

    $result = Invoke-AlertAction -TenantId $TenantId -AlertId $AlertId -Action $Action -Value $Value -Comment $Comment -Reason $Reason -DryRun:$DryRun -Confirmed:$Confirm -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
