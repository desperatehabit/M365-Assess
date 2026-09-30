<#
.SYNOPSIS
    Worker entrypoint for EPIC-021 connector add/edit/enable/disable/remove.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews connector create/edit/enable/disable/delete via
    Invoke-SetConnector, and emits the JSON envelope on stdout. An edit that
    changes nothing returns a structured no-op with no EXO write. The
    supervisor connects EXO in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here; a connector secret travels by reference and is
    resolved from the credential store inside the child only when
    -CredentialStore is supplied. -DryRun plans with no tenant write; apply
    requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'create' adds a connector; 'edit' changes one; 'enable'/'disable' set its
    state; 'delete' removes one.
.PARAMETER ConnectorId
    Direct connector identity for edit/enable/disable/delete runs without a
    job envelope.
.PARAMETER Name
    Connector name for create, or the new name for edit.
.PARAMETER Type
    'inbound' or 'outbound' for create.
.PARAMETER SenderDomains
    Partner sender domains for inbound create/edit.
.PARAMETER RecipientDomains
    Partner recipient domains for outbound create/edit.
.PARAMETER RequireTls
    'true' or 'false' to require TLS; empty leaves it unchanged.
.PARAMETER Enabled
    'true' or 'false' to set the connector state; empty leaves it unchanged.
.PARAMETER SecretRef
    Connector secret reference (e.g. a partner TLS certificate) for
    create/edit. The reference is resolved to material inside the child
    process only.
.PARAMETER CredentialStore
    Secret lookup scriptblock for connector secret material (T-0011).
    Required only when the run carries a secretRef.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-connector.ps1 -JobFile './run/connector-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-connector.ps1 -TenantId 'tenant-a' -Action 'disable' -ConnectorId 'connector-1' -Confirmed -DryRun
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
    [ValidateSet('create', 'edit', 'enable', 'disable', 'delete')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ConnectorId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Name = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('', 'inbound', 'outbound')]
    [string]$Type = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$SenderDomains = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$RecipientDomains = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('', 'true', 'false')]
    [string]$RequireTls = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('', 'true', 'false')]
    [string]$Enabled = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$SecretRef = '',

    [Parameter()]
    [scriptblock]$CredentialStore,

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-Connector.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    $jobEnabled = $null
    $jobRequireTls = $null
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetConnectorJob -Path $JobFile
        $TenantId         = $job['TenantId']
        $Action           = $job['Action']
        $ConnectorId      = $job['ConnectorId']
        $Name             = $job['Name']
        $Type             = $job['Type']
        $SenderDomains    = $job['SenderDomains']
        $RecipientDomains = $job['RecipientDomains']
        $SecretRef        = $job['SecretRef']
        $jobEnabled = $job['Enabled']
        $jobRequireTls = $job['RequireTls']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId         = $TenantId
        Action           = $Action
        ConnectorId      = $ConnectorId
        Name             = $Name
        Type             = $Type
        SenderDomains    = $SenderDomains
        RecipientDomains = $RecipientDomains
        SecretRef        = $SecretRef
        DryRun           = [bool]$DryRun
        Confirmed        = [bool]$Confirmed
    }
    if ($null -ne $CredentialStore) {
        $invokeParams['CredentialStore'] = $CredentialStore
    }
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        if ($null -ne $jobEnabled) {
            $invokeParams['Enabled'] = [bool]$jobEnabled
        }
        if ($null -ne $jobRequireTls) {
            $invokeParams['RequireTls'] = [bool]$jobRequireTls
        }
    }
    else {
        if ($Enabled -ne '') {
            $invokeParams['Enabled'] = ($Enabled -eq 'true')
        }
        if ($RequireTls -ne '') {
            $invokeParams['RequireTls'] = ($RequireTls -eq 'true')
        }
    }

    $result = Invoke-SetConnector @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
