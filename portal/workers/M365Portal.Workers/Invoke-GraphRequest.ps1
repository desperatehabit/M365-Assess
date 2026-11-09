# Invoke-GraphRequest.ps1 - EPIC-040 Graph Explorer request execution (SPEC 3.1, 4.1, 6, 8; T-0781).
#
# Executes one arbitrary Microsoft Graph request with the portal app's tenant
# credential. The BFF validates the request first (method allowlist, Graph host,
# no $batch/token endpoints, body size); this worker re-checks the method and
# host so a malformed job cannot become an arbitrary outbound request. The
# credential is resolved by Connect-WorkerTenant inside this process; this file
# never handles secret material.
#
# The result is the response envelope the Graph Explorer renders: status,
# headers, durationMs, and the parsed body. A non-2xx Graph response is returned
# as an envelope (status plus the Graph error body) rather than thrown, so the
# caller can render Graph's own error.

function Read-GraphRequestJob {
    <#
    .SYNOPSIS
        Parses a Graph Explorer job envelope.
    .DESCRIPTION
        The BFF sends { tenantId, credential, request: { method, url, body } }.
        The request fields are top-level under `request`, not the T-0007
        `payload` wrapper used by the EPICS-011..013 workers.
    .PARAMETER Path
        Path to the job envelope JSON.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }
    if ($null -eq $json.request) {
        throw "job envelope '$Path' is missing mandatory 'request'"
    }

    $request = $json.request
    return @{
        TenantId = [string]$json.tenantId
        Method   = [string]$request.method
        Url      = [string]$request.url
        Body     = $request.body
    }
}

function Assert-GraphRequestAllowed {
    <#
    .SYNOPSIS
        Re-checks the method and Graph host before the request runs.
    .DESCRIPTION
        Mirrors the BFF's Graph Explorer allowlist: GET/POST/PATCH/PUT/DELETE
        only, and the URL must target graph.microsoft.com over https. A failed
        check is a validation error, never a silent fallback.
    .PARAMETER Method
        HTTP method.
    .PARAMETER Url
        Absolute Graph URL.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Method,

        [Parameter(Mandatory)]
        [string]$Url
    )

    $allowed = @('GET', 'POST', 'PATCH', 'PUT', 'DELETE')
    if ($allowed -notcontains $Method.ToUpperInvariant()) {
        throw "graph-explorer.method_not_allowed: method must be one of: $($allowed -join ', ')"
    }
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) {
        throw 'graph-explorer.url_not_allowed: url must be an absolute URL'
    }
    if ($uri.Scheme -ne 'https' -or $uri.Host.ToLowerInvariant() -ne 'graph.microsoft.com') {
        throw 'graph-explorer.url_not_allowed: url must target graph.microsoft.com over https'
    }
    $path = $uri.AbsolutePath.ToLowerInvariant()
    if ($path -eq '/batch' -or $path.EndsWith('/batch') -or $path.Contains('$batch')) {
        throw 'graph-explorer.batch_not_allowed: $batch requests are not allowed'
    }
}

function Invoke-GraphRequest {
    <#
    .SYNOPSIS
        Runs one validated Graph request and shapes the response envelope.
    .PARAMETER TenantId
        Tenant the credential belongs to.
    .PARAMETER Method
        HTTP method.
    .PARAMETER Url
        Absolute Graph URL.
    .PARAMETER Body
        Optional request body (object or JSON string).
    .EXAMPLE
        Invoke-GraphRequest -TenantId 'tenant-a' -Method GET -Url 'https://graph.microsoft.com/v1.0/me'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Method,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Url,

        [Parameter()]
        [AllowNull()]
        [object]$Body = $null
    )

    Assert-GraphRequestAllowed -Method $Method -Url $Url

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $status = 200
    $headers = @{}
    $responseBody = $null

    $invokeParams = @{
        Method     = $Method.ToUpperInvariant()
        Uri        = $Url
        OutputType = 'PSObject'
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        if ($Body -is [string]) {
            $invokeParams['Body'] = $Body
        }
        else {
            $invokeParams['Body'] = ($Body | ConvertTo-Json -Depth 20 -Compress)
        }
    }

    try {
        $responseBody = Invoke-MgGraphRequest @invokeParams
    }
    catch {
        $status = 500
        $response = $_.Exception.Response
        if ($null -ne $response) {
            try { $status = [int]$response.StatusCode } catch { $status = 500 }
        }
        $message = $_.Exception.Message
        if ([string]::IsNullOrWhiteSpace($message)) { $message = 'Graph request failed' }
        $responseBody = @{
            error = @{
                code    = 'graph-explorer.request_failed'
                message = $message
            }
        }
    }
    finally {
        $stopwatch.Stop()
    }

    return [pscustomobject]@{
        status     = [int]$status
        headers    = $headers
        durationMs = [int]$stopwatch.ElapsedMilliseconds
        body       = $responseBody
    }
}
