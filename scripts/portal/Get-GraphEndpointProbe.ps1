<#
.SYNOPSIS
    Read-only Graph endpoint probe for live-tenant worker verification.
.DESCRIPTION
    Signs in to a tenant with the same credential path the portal workers use
    (Resolve-TenantCredential over the OS keystore), then issues a GET to each
    requested URI and records the HTTP status, result count, and error. It never
    mutates the tenant; it exists so the API-version and resource assumptions in
    T-0814/T-0847/T-0848 and EPIC-019/020 can be confirmed against real responses
    instead of documentation.
.PARAMETER TenantId
    Tenant GUID to sign in to.
.PARAMETER CredentialRef
    Full credential reference (the row secretRef), for example
    ref://tenants/<id>/credential/<uuid>.
.PARAMETER ClientId
    App registration (client) id.
.PARAMETER Thumbprint
    Certificate thumbprint (recorded only; the PFX path is resolved from the store).
.PARAMETER Environment
    Cloud environment: commercial, gcchigh, dod, or germany.
.PARAMETER Uri
    Graph resource paths to probe, with or without a leading slash.
.PARAMETER OutFile
    Optional path to write the probe results as JSON.
.EXAMPLE
    PS> ./Get-GraphEndpointProbe.ps1 -TenantId $t -CredentialRef $r -ClientId $c -Uri beta/deviceManagement/configurationPolicies
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredentialRef',
    Justification = 'CredentialRef is a storage reference (ref://...), never secret material.')]
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$CredentialRef,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ClientId,

    [Parameter()]
    [string]$Thumbprint = '',

    [Parameter()]
    [string]$Environment = 'commercial',

    [Parameter()]
    [string[]]$Uri = @(),

    [Parameter()]
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

$resolver = Join-Path -Path (Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent) -ChildPath 'portal/workers/M365Portal.Workers/Resolve-TenantCredential.ps1'
. $resolver

$record = [pscustomobject]@{
    tenantId    = $TenantId
    secretRef   = $CredentialRef
    authMethod  = 'certificate-pfx'
    clientId    = $ClientId
    thumbprint  = $Thumbprint
    environment = $Environment
}

$auth = Resolve-TenantCredential -TenantId $TenantId -CredentialRef $CredentialRef -CredentialRecord $record
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($auth.CertificatePath)
Connect-MgGraph -TenantId $TenantId -ClientId $auth.ClientId -Certificate $cert -NoWelcome | Out-Null

$results = foreach ($entry in $Uri) {
    $target = if ($entry.StartsWith('/')) { $entry } else { "/$entry" }
    try {
        $response = Invoke-MgGraphRequest -Method GET -Uri $target -ErrorAction Stop
        $count = $null
        if ($response -is [System.Collections.IDictionary]) {
            if ($response.Contains('value')) { $count = @($response['value']).Count }
        }
        elseif (@($response.PSObject.Properties.Name) -contains 'value') {
            $count = @($response.value).Count
        }
        [pscustomobject]@{ uri = $entry; ok = $true; status = 200; count = $count; error = $null; body = $null }
    }
    catch {
        $status = $null
        try {
            if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
                $status = [int]$_.Exception.Response.StatusCode
            }
        }
        catch { Write-Verbose "No HTTP status on the error: $($_.Exception.Message)" }
        # Invoke-MgGraphRequest puts the Graph error body in ErrorDetails.Message.
        $body = $null
        try { if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $body = $_.ErrorDetails.Message } }
        catch { Write-Verbose "No error body available: $($_.Exception.Message)" }
        [pscustomobject]@{ uri = $entry; ok = $false; status = $status; count = $null; error = $_.Exception.Message; body = $body }
    }
}

Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null

if ($OutFile) {
    $results | ConvertTo-Json -Depth 5 | Set-Content -Path $OutFile -Encoding UTF8
}
$results | ConvertTo-Json -Depth 5 -Compress
