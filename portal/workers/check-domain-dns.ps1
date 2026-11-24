<#
.SYNOPSIS
    Worker entrypoint for EPIC-034 DNS analysis.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant and domain directly),
    resolves and evaluates the domain's MX/SPF/DKIM/DMARC/MTA-STS/TLS-RPT
    records through Test-DomainDns, and emits the DomainCheck payload as JSON
    on stdout. DNS resolution needs no tenant authentication, so no Graph
    session is connected and no credential is read. The worker is read-only:
    it never writes a DNS record and never calls a tenant API.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id (carried for the uniform job envelope).
.PARAMETER Domain
    The domain to analyse.
.PARAMETER SelectorOverride
    Optional per-tenant DKIM selector override, tried first.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/check-domain-dns.ps1 -TenantId 'tenant-a' -Domain 'contoso.com'
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
    [string]$Domain,

    [Parameter()]
    [AllowEmptyString()]
    [string]$SelectorOverride = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Test-DomainDns.ps1')

if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
    $job = Read-DomainDnsJob -Path $JobFile
    $TenantId = $job['TenantId']
    $Domain = $job['Domain']
    if (-not $PSBoundParameters.ContainsKey('SelectorOverride')) {
        $SelectorOverride = $job['SelectorOverride']
    }
}

$result = Test-DomainDns -Domain $Domain -SelectorOverride $SelectorOverride
$result | ConvertTo-Json -Depth 8 -Compress
