<#
.SYNOPSIS
    Worker entrypoint for the EPIC-040 Graph Explorer.
.DESCRIPTION
    Reads a feature job envelope from -JobFile (or a tenant/method/url directly),
    executes the request through Invoke-GraphRequest with the tenant's portal
    app credential, and emits the response envelope as JSON on stdout. The BFF
    validates the request before dispatch; Assert-GraphRequestAllowed re-checks
    the method and Graph host here. Reads and writes both return Graph's own
    status and body; write authorization is the route's job.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Method
    GET, POST, PATCH, PUT, or DELETE.
.PARAMETER Url
    Absolute Microsoft Graph URL.
.PARAMETER BodyJson
    Optional JSON request body for direct-parameter runs.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-graph-request.ps1 -JobFile './run/graph-request-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-graph-request.ps1 -TenantId 'tenant-a' -Method GET -Url 'https://graph.microsoft.com/v1.0/users'
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
    [ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')]
    [string]$Method,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$Url,

    [Parameter(ParameterSetName = 'ByTenant')]
    [AllowEmptyString()]
    [string]$BodyJson = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-GraphRequest.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $Body = $null
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-GraphRequestJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Method = $job['Method']
        $Url = $job['Url']
        $Body = $job['Body']
    }
    elseif (-not [string]::IsNullOrWhiteSpace($BodyJson)) {
        $Body = $BodyJson | ConvertFrom-Json
    }

    $result = Invoke-GraphRequest -TenantId $TenantId -Method $Method -Url $Url -Body $Body
    $result | ConvertTo-Json -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
