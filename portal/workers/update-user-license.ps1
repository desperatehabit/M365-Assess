<#
.SYNOPSIS
    Worker entrypoint for EPIC-033 per-user licence assign/remove.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly) and
    dispatches on payload.operation: `plan` reads each user's current assignment
    state for the plan preview, `apply` executes the change per user through
    Invoke-UserLicenseBulk and emits the per-row results (with the LicenseChange
    and AuditEvent payloads the BFF persists) as JSON on stdout. -DryRun plans
    the change with no tenant write; a removal additionally requires -Confirm.
    The supervisor connects Graph in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret handling
    lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Operation
    plan or apply. Defaults to apply.
.PARAMETER SkuId
    The SKU to assign or remove.
.PARAMETER Action
    assign or remove. Defaults to assign.
.PARAMETER UserIds
    Target user ids.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirm
    Explicit confirmation for a removal.
.PARAMETER ContinueOnFailure
    Continue past a failed row instead of stopping the batch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/update-user-license.ps1 -JobFile './run/license-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/update-user-license.ps1 -TenantId 'tenant-a' -SkuId 'sku-1' -Action 'assign' -UserIds 'user-1' -DryRun
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
    [ValidateSet('plan', 'apply')]
    [string]$Operation = 'apply',

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$SkuId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('assign', 'remove')]
    [string]$Action = 'assign',

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [AllowEmptyCollection()]
    [string[]]$UserIds,

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirm,

    [Parameter()]
    [switch]$ContinueOnFailure
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Update-UserLicense.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $actor = ''
    $reason = ''
    $correlationId = ''
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-UserLicenseJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Operation = $job['Operation']
        $SkuId = $job['SkuId']
        $Action = $job['Action']
        $UserIds = $job['UserIds']
        $actor = $job['Actor']
        $reason = $job['Reason']
        $correlationId = $job['CorrelationId']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) { $DryRun = [bool]$job['DryRun'] }
        if (-not $PSBoundParameters.ContainsKey('Confirm')) { $Confirm = [bool]$job['Confirmed'] }
        if (-not $PSBoundParameters.ContainsKey('ContinueOnFailure')) { $ContinueOnFailure = [bool]$job['ContinueOnFailure'] }
    }

    if ($Operation -eq 'plan') {
        $result = Get-UserLicensePreview -TenantId $TenantId -SkuId $SkuId -UserIds $UserIds
    }
    else {
        $result = Invoke-UserLicenseBulk -TenantId $TenantId -SkuId $SkuId -Action $Action -UserIds $UserIds `
            -DryRun:$DryRun -Confirmed:$Confirm -ContinueOnFailure:$ContinueOnFailure `
            -Actor $actor -Reason $reason -CorrelationId $correlationId
    }

    $result | ConvertTo-Json -Depth 12 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
