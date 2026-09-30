<#
.SYNOPSIS
     Worker entrypoint for the EPIC-022 quarantine policy write.
.DESCRIPTION
     Reads a T-0007 job envelope from -JobFile (or parameters directly),
     executes or previews quarantine notification/permission policy
     create/edit/delete, and emits JSON on stdout. Stdout is the response
     transport; quarantine policies are never mirrored to disk. The
     supervisor connects EXO in this child process after materializing the
     tenant credential (T-0011) before invoking this script, so no secret
     handling lives here.
.PARAMETER JobFile
     Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
     Direct tenant id for runs without a job envelope.
.PARAMETER PolicyType
     Direct policy type for runs without a job envelope: notification or
     permission.
.PARAMETER Action
     Direct action for runs without a job envelope: create, edit, or delete.
.PARAMETER PolicyName
     Direct policy name for runs without a job envelope.
.PARAMETER SettingsJson
     Direct settings JSON for runs without a job envelope.
.PARAMETER Confirm
     Direct confirmation flag for runs without a job envelope.
.PARAMETER DryRun
     Direct dry-run flag for runs without a job envelope.
.EXAMPLE
     PS> pwsh -NoProfile -File portal/workers/set-quarantine-policy.ps1 -JobFile './run/set-quarantine-policy-job.json'
.EXAMPLE
     PS> pwsh -NoProfile -File portal/workers/set-quarantine-policy.ps1 -TenantId 'tenant-a' -PolicyType 'notification' -Action 'edit' -PolicyName 'Default' -SettingsJson '{"esnEnabled":true}'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateSet('notification', 'permission')]
    [string]$PolicyType,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateSet('create', 'edit', 'delete')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$PolicyName = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$SettingsJson = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [switch]$Confirm,

    [Parameter(ParameterSetName = 'ByParams')]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-QuarantinePolicy.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetQuarantinePolicyJob -Path $JobFile
        $TenantId   = $job['TenantId']
        $PolicyType = $job['PolicyType']
        $Action     = $job['Action']
        $PolicyName = $job['PolicyName']
        $Settings   = $job['Settings']
        $Confirm    = $job['Confirm']
        $DryRun     = $job['DryRun']
    }
    else {
        $Settings = @{}
        if (-not [string]::IsNullOrWhiteSpace($SettingsJson)) {
            $Settings = $SettingsJson | ConvertFrom-Json -AsHashtable
        }
    }

    $result = Invoke-SetQuarantinePolicy -TenantId $TenantId -PolicyType $PolicyType -Action $Action -PolicyName $PolicyName -Settings $Settings -Confirm $Confirm -DryRun $DryRun
    $result | ConvertTo-Json -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
