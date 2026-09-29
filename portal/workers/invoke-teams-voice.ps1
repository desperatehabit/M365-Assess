<#
.SYNOPSIS
    Worker entrypoint for EPIC-026 Teams Business Voice.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews the voice-number inventory, assignment, release, or
    voice-policy assignment via Invoke-TeamsVoice, and emits the JSON envelope
    on stdout. Voice is license-gated: writes are refused when the tenant holds
    no active Phone System service plan. The supervisor connects Graph in this
    child process after materializing the tenant credential (T-0011) before
    invoking this script, so no secret handling lives here. -DryRun plans
    with no tenant write; apply requires -Confirmed, and release requires
    explicit confirmation.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'list' reads the inventory and license state; 'assign', 'release', and
    'policy' apply through the gated executor.
.PARAMETER NumberId
    Direct phone-number assignment identity for release runs without a job envelope.
.PARAMETER PhoneNumber
    Direct phone number for assign runs without a job envelope.
.PARAMETER TargetId
    Direct user/resource account identity for assign and policy runs without a job envelope.
.PARAMETER PolicyId
    Direct voice routing policy identity for policy runs without a job envelope.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-teams-voice.ps1 -JobFile './run/voice-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-teams-voice.ps1 -TenantId 'tenant-a' -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1' -Confirmed -DryRun
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
    [ValidateSet('list', 'assign', 'release', 'policy')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$NumberId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$PhoneNumber = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$TargetId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$PolicyId = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-TeamsVoice.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-TeamsVoiceJob -Path $JobFile
        $TenantId    = $job['TenantId']
        $Action      = $job['Action']
        $NumberId    = $job['NumberId']
        $PhoneNumber = $job['PhoneNumber']
        $TargetId    = $job['TargetId']
        $PolicyId    = $job['PolicyId']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId    = $TenantId
        Action      = $Action
        NumberId    = $NumberId
        PhoneNumber = $PhoneNumber
        TargetId    = $TargetId
        PolicyId    = $PolicyId
        DryRun      = [bool]$DryRun
        Confirmed   = [bool]$Confirmed
    }

    $result = Invoke-TeamsVoice @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
