<#
.SYNOPSIS
     Worker entrypoint for the EPIC-024 message encryption read and gated OME template apply.
.DESCRIPTION
     Reads a T-0007 job envelope from -JobFile (or parameters directly),
     reads the IRM/OME configuration and OME template settings live from
     Exchange Online via Get-MessageEncryption, or previews/applies an OME
     template change via Invoke-MessageEncryptionTemplate, and emits the JSON
     envelope on stdout. Stdout is the response transport; configuration data
     is never mirrored to disk. The supervisor connects EXO in this child
     process after materializing the tenant credential (T-011) before
     invoking this script, so no secret handling lives here. -DryRun plans
     with no tenant write; apply requires -Confirmed.
.PARAMETER JobFile
     Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
     Direct tenant id for runs without a job envelope.
.PARAMETER Action
     'read' returns the IRM/OME configuration and templates; 'apply' previews
     or applies one OME template change.
.PARAMETER TemplateId
     OME template identity for apply runs without a job envelope.
.PARAMETER Settings
     JSON object of OME template settings to change for apply runs without a
     job envelope.
.PARAMETER DryRun
     Report the intended change without writing to the tenant.
.PARAMETER Confirmed
     Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
     PS> pwsh -NoProfile -File portal/workers/get-message-encryption.ps1 -JobFile './run/message-encryption-job.json'
.EXAMPLE
     PS> pwsh -NoProfile -File portal/workers/get-message-encryption.ps1 -TenantId 'tenant-a' -Action 'apply' -TemplateId 'Default' -Settings '{"portalText":"Confidential"}' -Confirmed -DryRun
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
    [ValidateSet('read', 'apply')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$TemplateId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Settings = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-MessageEncryption.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-MessageEncryptionJob -Path $JobFile
        $TenantId   = $job['TenantId']
        $Action     = $job['Action']
        $TemplateId = $job['TemplateId']
        $Settings   = $job['Settings']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
    }

    if ($Action -eq 'apply') {
        $settingsHash = @{}
        if ($Settings -is [System.Collections.IDictionary]) {
            $settingsHash = $Settings
        }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$Settings)) {
            $parsed = ConvertFrom-Json -InputObject ([string]$Settings) -AsHashtable
            if ($parsed -is [System.Collections.IDictionary]) {
                $settingsHash = $parsed
            }
        }
        $result = Invoke-MessageEncryptionTemplate -TenantId $TenantId -TemplateId $TemplateId -Settings $settingsHash -DryRun ([bool]$DryRun) -Confirmed ([bool]$Confirmed)
    }
    else {
        $result = Get-MessageEncryption -TenantId $TenantId
    }
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
