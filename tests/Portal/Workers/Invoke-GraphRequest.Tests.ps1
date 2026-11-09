# Invoke-GraphRequest.Tests.ps1
# Pester tests for T-0781/T-0870 - the Graph Explorer worker.
# Asserts: the job reader consumes the top-level `request` block; the worker
# issues the requested method/url/body; a Graph failure is returned as an
# envelope; the method/host allowlist re-checks a malformed job; and the
# response carries status, headers, duration, and body.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Invoke-GraphRequest worker (T-0781, mounted by T-0870)' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
        $script:implementation = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-GraphRequest.ps1'
        . $script:implementation

        function global:Invoke-MgGraphRequest {
            param($Method, $Uri, $Body, $OutputType, $ErrorAction)
        }
    }

    BeforeEach {
        $script:called = $null
    }

    It 'reads the top-level request block from the job envelope' {
        $job = Join-Path $TestDrive 'graph-request-job.json'
        @{
            tenantId = 'tenant-a'
            request  = @{ method = 'GET'; url = 'https://graph.microsoft.com/v1.0/users'; body = @{ top = 5 } }
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $job

        $parsed = Read-GraphRequestJob -Path $job

        $parsed['TenantId'] | Should -Be 'tenant-a'
        $parsed['Method'] | Should -Be 'GET'
        $parsed['Url'] | Should -Be 'https://graph.microsoft.com/v1.0/users'
        $parsed['Body'].top | Should -Be 5
    }

    It 'runs the request and returns the response envelope' {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body, $OutputType, $ErrorAction)
            $script:called = @{ Method = $Method; Uri = $Uri; Body = $Body }
            return @{ value = @(@{ id = 'user-1' }) }
        }

        $result = Invoke-GraphRequest -TenantId 'tenant-a' -Method GET -Url 'https://graph.microsoft.com/v1.0/users'

        $script:called.Method | Should -Be 'GET'
        $script:called.Uri | Should -Be 'https://graph.microsoft.com/v1.0/users'
        $result.status | Should -Be 200
        $result.durationMs | Should -BeGreaterOrEqual 0
        $result.body.value[0].id | Should -Be 'user-1'
        ($result.headers | ConvertTo-Json -Compress) | Should -Be '{}'
    }

    It 'serializes an object body and sends the requested method' {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body, $OutputType, $ErrorAction)
            $script:called = @{ Method = $Method; Uri = $Uri; Body = $Body }
            return @{ id = 'group-1' }
        }

        $result = Invoke-GraphRequest -TenantId 'tenant-a' -Method POST -Url 'https://graph.microsoft.com/v1.0/groups' -Body @{ displayName = 'Probe' }

        $script:called.Method | Should -Be 'POST'
        ($script:called.Body | ConvertFrom-Json).displayName | Should -Be 'Probe'
        $result.status | Should -Be 200
        $result.body.id | Should -Be 'group-1'
    }

    It 'returns a Graph failure as an envelope instead of throwing' {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body, $OutputType, $ErrorAction)
            throw 'Graph returned 403 Forbidden'
        }

        $result = Invoke-GraphRequest -TenantId 'tenant-a' -Method GET -Url 'https://graph.microsoft.com/v1.0/users'

        $result.status | Should -Be 500
        $result.body.error.code | Should -Be 'graph-explorer.request_failed'
        $result.body.error.message | Should -Match '403'
    }

    It 'refuses a method outside the allowlist' {
        { Invoke-GraphRequest -TenantId 'tenant-a' -Method 'TRACE' -Url 'https://graph.microsoft.com/v1.0/users' } |
            Should -Throw '*method_not_allowed*'
    }

    It 'refuses a URL outside graph.microsoft.com' {
        { Invoke-GraphRequest -TenantId 'tenant-a' -Method GET -Url 'https://login.microsoftonline.com/tenant-a/oauth2/v2.0/token' } |
            Should -Throw '*url_not_allowed*'
    }
}
