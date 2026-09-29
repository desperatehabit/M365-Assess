<#
.SYNOPSIS
    Worker entrypoint for EPIC-020 retention tag assignment.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews per-mailbox and bulk retention tag assignment via
    Invoke-SetRetentionTag, and emits the JSON envelope on stdout. A mailbox
    that already carries the tag is a per-row no-op with no EXO write. The
    supervisor connects EXO in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here. -DryRun plans with no tenant write; apply requires
    -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'assign' targets one mailbox; 'assignBulk' targets many.
.PARAMETER TagId
    Direct retention tag identity for runs without a job envelope.
.PARAMETER PolicyId
    Direct retention policy identity for runs without a job envelope.
.PARAMETER MailboxId
    Direct mailbox identity for single assign runs without a job envelope.
.PARAMETER MailboxIds
    Direct mailbox identities for bulk assign runs without a job envelope.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-retention-tag.ps1 -JobFile './run/retention-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-retention-tag.ps1 -TenantId 'tenant-a' -Action 'assign' -TagId 'tag-1' -MailboxId 'mbx-2' -Confirmed -DryRun
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
    [ValidateSet('assign', 'assignBulk')]
    [string]$Action,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TagId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$PolicyId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$MailboxId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string[]]$MailboxIds = @(),

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-RetentionTag.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetRetentionTagJob -Path $JobFile
        $TenantId   = $job['TenantId']
        $Action     = $job['Action']
        $TagId      = $job['TagId']
        $PolicyId   = $job['PolicyId']
        $MailboxId  = $job['MailboxId']
        $MailboxIds = $job['MailboxIds']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId   = $TenantId
        Action     = $Action
        TagId      = $TagId
        PolicyId   = $PolicyId
        MailboxId  = $MailboxId
        MailboxIds = $MailboxIds
        DryRun     = [bool]$DryRun
        Confirmed  = [bool]$Confirmed
    }

    $result = Invoke-SetRetentionTag @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
