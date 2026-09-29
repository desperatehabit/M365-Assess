<#
.SYNOPSIS
    Worker entrypoint for EPIC-026 Teams & Voice LIS Locations CRUD operations.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews LIS location create/edit/delete/list, and emits JSON on stdout.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
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
    [ValidateSet('list', 'create', 'edit', 'delete')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$LocationId = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$DisplayName = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$Street = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$City = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$State = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$Country = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$PostalCode = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$CompanyName = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$ConfirmName = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-LisLocation.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $invokeParams = @{
        TenantId    = $TenantId
        Action      = $Action
        LocationId  = $LocationId
        DisplayName = $DisplayName
        Street      = $Street
        City        = $City
        State       = $State
        Country     = $Country
        PostalCode  = $PostalCode
        CompanyName = $CompanyName
        ConfirmName = $ConfirmName
        DryRun      = [bool]$DryRun
    }

    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-InvokeLisLocationJob -Path $JobFile
        $invokeParams['TenantId']    = $job['TenantId']
        $invokeParams['Action']      = $job['Action']
        $invokeParams['LocationId']  = $job['LocationId']
        $invokeParams['DisplayName'] = $job['DisplayName']
        $invokeParams['Street']      = $job['Street']
        $invokeParams['City']        = $job['City']
        $invokeParams['State']       = $job['State']
        $invokeParams['Country']     = $job['Country']
        $invokeParams['PostalCode']  = $job['PostalCode']
        $invokeParams['CompanyName'] = $job['CompanyName']
        $invokeParams['ConfirmName'] = $job['ConfirmName']
        $invokeParams['DryRun']      = [bool]$job['DryRun']
    }

    $result = Invoke-LisLocation @invokeParams
    $result | ConvertTo-Json -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
