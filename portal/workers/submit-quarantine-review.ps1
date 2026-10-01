<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 quarantine submit-for-review action.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant, message, and recipient
    directly), submits the quarantined message to Microsoft for review via
    Submit-QuarantineReview, and emits the result as JSON on stdout. The
    supervisor connects EXO and Graph in this child process after materializing
    the tenant credential before invoking this script, so no secret handling
    lives here. -Refresh reads the live submission state back instead of
    re-submitting. Per SPEC §11.1 the message content comes from the EXO
    quarantine cmdlet and the submission/status from the Graph threat-submission
    API.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER MessageId
    Direct quarantined message id for runs without a job envelope.
.PARAMETER Recipient
    Recipient address the submission names.
.PARAMETER Category
    Submission category: notJunk, spam, phishing, or malware.
.PARAMETER Refresh
    Read the live submission state instead of submitting again.
.PARAMETER SubmissionId
    The submission to read when -Refresh is set.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/submit-quarantine-review.ps1 -JobFile './run/quarantine-submit-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/submit-quarantine-review.ps1 -TenantId 'tenant-a' -MessageId 'message-1' -Recipient 'user@example.invalid'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [ValidateNotNullOrEmpty()]
    [string]$MessageId,

    [Parameter(ParameterSetName = 'ByDirect')]
    [string]$Recipient = '',

    [Parameter(ParameterSetName = 'ByDirect')]
    [ValidateSet('notJunk', 'spam', 'phishing', 'malware')]
    [string]$Category = 'spam',

    [Parameter(ParameterSetName = 'ByDirect')]
    [switch]$Refresh,

    [Parameter(ParameterSetName = 'ByDirect')]
    [string]$SubmissionId = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Submit-QuarantineReview.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service @('Graph', 'ExchangeOnline')
}
try {
    $Actor = ''
    $CorrelationId = ''
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-QuarantineSubmitJob -Path $JobFile
        $TenantId = $job['TenantId']
        $MessageId = $job['MessageId']
        $Recipient = $job['Recipient']
        $Category = $job['Category']
        if (-not $PSBoundParameters.ContainsKey('Refresh')) {
            $Refresh = [bool]$job['Refresh']
        }
        $SubmissionId = $job['SubmissionId']
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $invokeParams = @{
        TenantId      = $TenantId
        MessageId     = $MessageId
        Recipient     = $Recipient
        Category      = $Category
        SubmissionId  = $SubmissionId
        Actor         = $Actor
        CorrelationId = $CorrelationId
    }
    if ($Refresh) {
        $invokeParams['Refresh'] = $true
    }
    $result = Submit-QuarantineReview @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
