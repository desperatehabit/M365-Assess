BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-PurviewRetention.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-purview-retention.ps1'

    function global:Get-RetentionCompliancePolicy {
        param()
    }

    function global:Get-RetentionComplianceRule {
        param()
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:policy1 = @{
        Identity          = 'policy-1'
        Name              = 'Finance 7yr'
        Enabled           = $true
        Mode              = 'Enforce'
        ExchangeLocation  = @('All')
        SharePointLocation = @('All')
        OneDriveLocation  = @()
        TeamsChannelLocation = @()
        TeamsChatLocation    = @()
    }
    $script:policy2 = @{
        Identity          = 'policy-2'
        Name              = 'Legal Hold'
        Enabled           = $false
        Mode              = 'Enforce'
        ExchangeLocation  = @()
        SharePointLocation = @()
        OneDriveLocation  = @()
        TeamsChannelLocation = @('All')
        TeamsChatLocation    = @()
    }
    $script:rule1 = @{
        Name              = 'Finance 7yr'
        Policy            = 'Finance 7yr'
        RetentionDuration = '2555 days'
        RetentionAction   = 'Delete'
    }
    $script:rule2 = @{
        Name              = 'Legal Hold'
        Policy            = 'Legal Hold'
        RetentionDuration = 'Unlimited'
        RetentionAction   = 'Keep'
    }

    function script:New-PurviewRetentionMock {
        Mock Get-RetentionCompliancePolicy {
            return @($script:policy1, $script:policy2)
        }
        Mock Get-RetentionComplianceRule {
            return @($script:rule1, $script:rule2)
        }
    }
}

Describe 'Get-PurviewRetention worker (T-0584)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-PurviewRetention -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-PurviewRetentionRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-PurviewRetentionJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Connect-WorkerPurview -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues Get- cmdlets and no Set-/New-/Remove-/Enable-/Disable-' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-RetentionCompliancePolicy'
            $source | Should -Match 'Get-RetentionComplianceRule'
            $source | Should -Not -Match 'Set-RetentionCompliancePolicy'
            $source | Should -Not -Match 'New-RetentionCompliancePolicy'
            $source | Should -Not -Match 'Remove-RetentionCompliancePolicy'
            $source | Should -Not -Match 'Enable-RetentionCompliancePolicy'
            $source | Should -Not -Match 'Disable-RetentionCompliancePolicy'
        }

        It 'never persists retention state to disk, logs, or artifacts' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match 'Out-File'
            $entrySource | Should -Not -Match 'Start-Transcript'
        }

        It 'entrypoint connects Purview in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-PurviewRetention\.ps1'
            $entrySource | Should -Match 'Connect-WorkerPurview -JobFile \$JobFile'
            $entrySource | Should -Match 'Read-PurviewRetentionJob -Path'
            $entrySource | Should -Match 'Get-PurviewRetention @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
            $entrySource | Should -Match 'Disconnect-WorkerPurview'
        }
    }

    Context 'list mapping' {
        BeforeEach {
            script:New-PurviewRetentionMock
        }

        It 'returns the §3.2 columns with cursor paging metadata' {
            $result = Get-PurviewRetention -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.items | Should -HaveCount 2
            $result.nextCursor | Should -Be ''
            $result.totalCount | Should -Be 2
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $row = @($result.items | Where-Object { $_.id -eq 'policy-1' })[0]
            $row.name | Should -Be 'Finance 7yr'
            $row.state | Should -Be 'enabled'
            $row.locations | Should -Contain 'Exchange'
            $row.locations | Should -Contain 'SharePoint'
            $row.retentionPeriod | Should -Be '2555 days'
            $row.disposition | Should -Be 'Delete'
        }

        It 'maps the disabled state and Teams location' {
            $result = Get-PurviewRetention -TenantId 'tenant-a'

            $row = @($result.items | Where-Object { $_.id -eq 'policy-2' })[0]
            $row.name | Should -Be 'Legal Hold'
            $row.state | Should -Be 'disabled'
            $row.locations | Should -Contain 'Teams'
            $row.retentionPeriod | Should -Be 'Unlimited'
            $row.disposition | Should -Be 'Keep'
        }

        It 'orders rows by name' {
            $result = Get-PurviewRetention -TenantId 'tenant-a'

            @($result.items).id | Should -Be @('policy-1', 'policy-2')
        }

        It 'requires the tenant identifier' {
            { Get-PurviewRetention -TenantId '' } | Should -Throw
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-PurviewRetentionMock
        }

        It 'searches policy names case-insensitively' {
            (Get-PurviewRetention -TenantId 'tenant-a' -Search 'FINANCE').items | Should -HaveCount 1
            $result = Get-PurviewRetention -TenantId 'tenant-a' -Search 'legal'
            $result.items | Should -HaveCount 1
            @($result.items)[0].id | Should -Be 'policy-2'
        }

        It 'filters by enabled and disabled state' {
            @(Get-PurviewRetention -TenantId 'tenant-a' -State 'enabled').items.id | Should -Be @('policy-1')
            @(Get-PurviewRetention -TenantId 'tenant-a' -State 'disabled').items.id | Should -Be @('policy-2')
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-PurviewRetentionMock
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-PurviewRetention -TenantId 'tenant-a' -Top 1

            $first.items | Should -HaveCount 1
            $first.totalCount | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-PurviewRetention -TenantId 'tenant-a' -Top 1 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 1
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).id | Should -Be @('policy-1', 'policy-2')
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-PurviewRetention -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-PurviewRetention -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'policy-1'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload filters' {
            $jobPath = Join-Path $TestDrive 'purview-retention-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                jobType       = 'assessment'
                tenantId      = 'tenant-a'
                runId         = 'run-1'
                requestId     = 'req-1'
                correlationId = 'corr-1'
                createdAt     = '2026-01-01T00:00:00.000Z'
                payload       = @{
                    contextRef    = 'runs/run-1/context.json'
                    outputRef     = 'runs/run-1'
                    credentialRef = 'tenants/tenant-a/credential'
                    sectionRefs   = @()
                    artifactRefs  = @()
                    filters       = @{ state = 'enabled'; top = 25 }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-PurviewRetentionJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['State'] | Should -Be 'enabled'
            $job['Top'] | Should -Be 25
            $job['Search'] | Should -Be ''
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'purview-retention-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-PurviewRetentionJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'purview-retention-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-PurviewRetentionJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-PurviewRetentionJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }

    Context 'Purview session seam' {
        It 'Connect-WorkerPurview resolves the credential and connects app-only' {
            $tempFile = [System.IO.Path]::GetTempFileName()
            $connectScript = Join-Path $TestDrive 'fake-connect.ps1'
            $connectLog = Join-Path $TestDrive 'connect-log.json'
            try {
                @{
                    tenantId = 'tenant-xyz'
                    credential = @{
                        credentialRef = 'tenants/tenant-xyz/credential'
                        record = @{
                            tenantId = 'tenant-xyz'
                            authMethod = 'certificate-thumbprint'
                            clientId = 'client-abc'
                            thumbprint = 'thumb-123'
                            environment = 'commercial'
                        }
                    }
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempFile

                Mock Resolve-TenantCredential {
                    return @{
                        Method = 'Certificate'
                        ClientId = 'client-abc'
                        CertificateThumbprint = 'thumb-123'
                        M365Environment = 'commercial'
                    }
                }
                Mock Protect-WorkerSecret {
                    param($Message, $Secrets)
                    return $Message
                }

                @"
param(`$Service, `$TenantId, `$ClientId, `$CertificateThumbprint, `$M365Environment)
@{
    Service = `$Service
    TenantId = `$TenantId
    ClientId = `$ClientId
    CertificateThumbprint = `$CertificateThumbprint
    M365Environment = `$M365Environment
} | ConvertTo-Json | Set-Content -LiteralPath '$connectLog'
return `$true
"@ | Set-Content -LiteralPath $connectScript

                $session = Connect-WorkerPurview -JobFile $tempFile -ConnectScript $connectScript

                $session.TenantId | Should -Be 'tenant-xyz'
                $logged = Get-Content -LiteralPath $connectLog -Raw | ConvertFrom-Json
                $logged.Service | Should -Be 'Purview'
                $logged.TenantId | Should -Be 'tenant-xyz'
                $logged.ClientId | Should -Be 'client-abc'
                $logged.CertificateThumbprint | Should -Be 'thumb-123'
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
