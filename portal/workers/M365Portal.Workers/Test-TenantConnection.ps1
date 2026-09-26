# Test-TenantConnection.ps1 — EPIC-002 live read-only connect test (SPEC §4.1, §4.2, §6, §10).
#
# Runs a live, read-only connect check across Microsoft cloud services (Graph,
# ExchangeOnline, Purview) and returns a per-service pass/fail envelope.
# Resolves credentials inside the child process via Resolve-TenantCredential (T-0011);
# secret material is never persisted, echoed to stdout, or returned in error payloads.
# This operation is strictly read-only and writes no tenant configuration.

[CmdletBinding()]
param(
    [Parameter()]
    [string]$TenantId,

    [Parameter()]
    [string]$CredentialRef,

    [Parameter()]
    [object]$CredentialRecord,

    [Parameter()]
    [scriptblock]$CredentialStore,

    [Parameter()]
    [string[]]$Services = @('Graph', 'ExchangeOnline', 'Purview'),

    [Parameter()]
    [string]$ConnectScript = '',

    [Parameter()]
    [scriptblock]$ConnectHandler
)

$script:WorkerDirectory = $PSScriptRoot
if (-not $script:WorkerDirectory) {
    $script:WorkerDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$script:ResolverScript = Join-Path -Path $script:WorkerDirectory -ChildPath 'Resolve-TenantCredential.ps1'
if (Test-Path -LiteralPath $script:ResolverScript -PathType Leaf) {
    . $script:ResolverScript
}

function Test-TenantConnection {
    <#
    .SYNOPSIS
        Tests live read-only connectivity to Microsoft cloud services for a tenant.
    .DESCRIPTION
        Resolves tenant credentials via Resolve-TenantCredential, performs a read-only
        connection probe for each requested service (Graph, ExchangeOnline, Purview),
        and returns a structured result envelope with per-service pass/fail status.
        Any errors are redacted via Protect-WorkerSecret so secrets are never echoed.
    .PARAMETER TenantId
        Tenant Entra ID / GUID to test.
    .PARAMETER CredentialRef
        Reference to the credential row (e.g. tenants/<id>/credential or ref://...).
    .PARAMETER CredentialRecord
        Non-secret TenantCredential row fields.
    .PARAMETER CredentialStore
        Optional scriptblock returning secret material for the row secretRef.
    .PARAMETER Services
        List of services to test. Defaults to Graph, ExchangeOnline, Purview.
    .PARAMETER ConnectScript
        Optional path to Connect-Service.ps1. Defaults to the module's script.
    .PARAMETER ConnectHandler
        Optional custom scriptblock for probing service connectivity (for tests/mocks).
    .OUTPUTS
        System.Management.Automation.PSCustomObject
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CredentialRef,

        [Parameter(Mandatory)]
        [object]$CredentialRecord,

        [Parameter()]
        [scriptblock]$CredentialStore,

        [Parameter()]
        [string[]]$Services = @('Graph', 'ExchangeOnline', 'Purview'),

        [Parameter()]
        [string]$ConnectScript = '',

        [Parameter()]
        [scriptblock]$ConnectHandler
    )

    if (-not (Get-Command -Name 'Resolve-TenantCredential' -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath $script:ResolverScript -PathType Leaf) {
            . $script:ResolverScript
        }
        else {
            throw "Resolve-TenantCredential script not found at: $script:ResolverScript"
        }
    }

    # Materialize credential strictly in-memory inside child process
    $auth = Resolve-TenantCredential -TenantId $TenantId `
                                    -CredentialRef $CredentialRef `
                                    -CredentialRecord $CredentialRecord `
                                    -CredentialStore $CredentialStore

    if (-not $ConnectScript -and -not $ConnectHandler) {
        $repoRoot = Split-Path -Path (Split-Path -Path (Split-Path -Path $script:WorkerDirectory -Parent) -Parent) -Parent
        $candidate = Join-Path -Path $repoRoot -ChildPath 'src/M365-Assess/Common/Connect-Service.ps1'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $ConnectScript = $candidate
        }
    }

    $serviceResults = @()
    $testedAt = (Get-Date).ToUniversalTime().ToString('o')

    foreach ($svc in $Services) {
        $svcStatus = 'pass'
        $connected = $false
        $errorMsg = $null

        # Client secret auth is rejected up front for EXO and Purview per module rules
        if ($auth.Method -eq 'ClientSecret' -and ($svc -eq 'ExchangeOnline' -or $svc -eq 'Purview')) {
            $serviceResults += [pscustomobject]@{
                service   = $svc
                status    = 'fail'
                connected = $false
                error     = "Exchange Online and Purview do not support client-secret authentication; certificate authentication is required."
            }
            continue
        }

        try {
            if ($ConnectHandler) {
                $probeResult = & $ConnectHandler -Service $svc -Auth $auth -TenantId $TenantId
                if ($probeResult -eq $false) {
                    throw "Connection probe returned false for service '$svc'."
                }
                $connected = $true
            }
            elseif ($ConnectScript -and (Test-Path -LiteralPath $ConnectScript -PathType Leaf)) {
                $connectParams = @{
                    Service  = $svc
                    TenantId = $TenantId
                }
                if ($auth.ClientId) { $connectParams['ClientId'] = $auth.ClientId }
                if ($auth.CertificateThumbprint) { $connectParams['CertificateThumbprint'] = $auth.CertificateThumbprint }
                if ($auth.Certificate) { $connectParams['Certificate'] = $auth.Certificate }
                if ($auth.CertificatePath) { $connectParams['CertificatePath'] = $auth.CertificatePath }
                if ($auth.CertificatePassword) { $connectParams['CertificatePassword'] = $auth.CertificatePassword }
                if ($auth.ClientSecret) { $connectParams['ClientSecret'] = $auth.ClientSecret }
                if ($auth.M365Environment) { $connectParams['M365Environment'] = $auth.M365Environment }

                $connectOutput = & $ConnectScript @connectParams
                if ($connectOutput -eq $false) {
                    throw "Connect-Service returned false for service '$svc'."
                }
                $connected = $true
            }
            else {
                throw "No connect script or connect handler available to test service '$svc'."
            }
        }
        catch {
            $rawMsg = $_.Exception.Message
            if (Get-Command -Name 'Protect-WorkerSecret' -ErrorAction SilentlyContinue) {
                $errorMsg = Protect-WorkerSecret -Message $rawMsg -Secrets @($auth.ClientSecret, $auth.CertificatePassword)
            }
            else {
                $errorMsg = $rawMsg
            }
            $svcStatus = 'fail'
            $connected = $false
        }
        finally {
            # Disconnect sessions to maintain isolation and prevent state leaks
            if ($svc -eq 'ExchangeOnline' -or $svc -eq 'Purview') {
                if (Get-Command -Name 'Disconnect-ExchangeOnline' -ErrorAction SilentlyContinue) {
                    try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } catch {}
                }
            }
            elseif ($svc -eq 'Graph') {
                if (Get-Command -Name 'Disconnect-MgGraph' -ErrorAction SilentlyContinue) {
                    try { Disconnect-MgGraph -ErrorAction SilentlyContinue } catch {}
                }
            }
        }

        $serviceResults += [pscustomobject]@{
            service   = $svc
            status    = $svcStatus
            connected = $connected
            error     = $errorMsg
        }
    }

    $allPassed = $true
    foreach ($sr in $serviceResults) {
        if ($sr.status -ne 'pass') {
            $allPassed = $false
            break
        }
    }

    return [pscustomobject]@{
        tenantId = $TenantId
        success  = [bool]$allPassed
        testedAt = $testedAt
        services = @($serviceResults)
    }
}

if ($TenantId -and $CredentialRef -and $CredentialRecord) {
    $result = Test-TenantConnection -TenantId $TenantId `
                                   -CredentialRef $CredentialRef `
                                   -CredentialRecord $CredentialRecord `
                                   -CredentialStore $CredentialStore `
                                   -Services $Services `
                                   -ConnectScript $ConnectScript `
                                   -ConnectHandler $ConnectHandler
    return $result
}
