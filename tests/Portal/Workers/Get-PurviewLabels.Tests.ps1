BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-PurviewLabels.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-purview-labels.ps1'

    function global:Get-Label {
        param()
    }

    function global:Get-LabelPolicy {
        param()
    }

    function global:Get-DlpSensitiveInformationType {
        param()
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:label1 = @{
        Identity                      = 'label-1'
        Name                          = 'Confidential'
        DisplayName                   = 'Confidential'
        Priority                      = 1
        Disabled                      = $false
        Scope                         = @('File', 'Email')
        EncryptionEnabled             = $true
        EncryptionProtectionType      = 'Template'
        EncryptionTemplateId          = 'template-1'
        EncryptionRightsDefinitions   = @('principal-a:VIEW', 'principal-b:EDIT')
        EncryptionContentExpiredOnDateInDaysOrNever = 'Never'
        EncryptionOfflineAccessDays   = 30
        ApplyContentMarkingHeaderText = 'Confidential'
        ApplyContentMarkingFooterText = ''
        ApplyWatermarkText            = ''
    }
    $script:label2 = @{
        Identity                      = 'label-2'
        Name                          = 'Public'
        DisplayName                   = 'Public'
        Priority                      = 5
        Disabled                      = $true
        Scope                         = @('File')
        EncryptionEnabled             = $false
        EncryptionProtectionType      = ''
        EncryptionTemplateId          = ''
        EncryptionRightsDefinitions   = @()
        ApplyContentMarkingHeaderText = ''
        ApplyContentMarkingFooterText = ''
        ApplyWatermarkText            = ''
    }
    $script:policy1 = @{
        Name   = 'Default Policy'
        Labels = @('label-1')
    }
    $script:sit1 = @{
        Guid                 = 'sit-1'
        Name                 = 'Credit Card Number'
        IsCustom             = $false
        RecommendedConfidence = 'High'
        BasedOn              = ''
    }
    $script:sit2 = @{
        Guid                 = 'sit-2'
        Name                 = 'Employee Identifier'
        IsCustom             = $true
        RecommendedConfidence = 'Medium'
        BasedOn              = 'Credit Card Number'
    }

    function script:New-PurviewLabelsMock {
        Mock Get-Label {
            return @($script:label1, $script:label2)
        }
        Mock Get-LabelPolicy {
            return @($script:policy1)
        }
        Mock Get-DlpSensitiveInformationType {
            return @($script:sit1, $script:sit2)
        }
    }
}

Describe 'Get-PurviewLabels worker (T-0587)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-PurviewLabels -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-PurviewSits -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-PurviewLabelRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-PurviewSitRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-PurviewLabelsJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Connect-WorkerPurview -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues Get- cmdlets and no Set-/New-/Remove-/Enable-/Disable-' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-Label'
            $source | Should -Match 'Get-LabelPolicy'
            $source | Should -Match 'Get-DlpSensitiveInformationType'
            $source | Should -Not -Match 'Set-Label'
            $source | Should -Not -Match 'New-Label'
            $source | Should -Not -Match 'Remove-Label'
            $source | Should -Not -Match 'Enable-Label'
            $source | Should -Not -Match 'Disable-Label'
        }

        It 'never persists label or SIT state to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-PurviewLabels\.ps1'
            $entrySource | Should -Match 'Connect-WorkerPurview -JobFile \$JobFile'
            $entrySource | Should -Match 'Read-PurviewLabelsJob -Path'
            $entrySource | Should -Match 'Get-PurviewLabels @invokeParams'
            $entrySource | Should -Match 'Get-PurviewSits @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
            $entrySource | Should -Match 'Disconnect-WorkerPurview'
        }
    }

    Context 'label list mapping' {
        BeforeEach {
            script:New-PurviewLabelsMock
        }

        It 'returns the §3.3 columns with cursor paging metadata' {
            $result = Get-PurviewLabels -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.kind | Should -Be 'labels'
            $result.items | Should -HaveCount 2
            $result.totalCount | Should -Be 2
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $row = @($result.items | Where-Object { $_.id -eq 'label-1' })[0]
            $row.name | Should -Be 'Confidential'
            $row.scope | Should -Contain 'File'
            $row.scope | Should -Contain 'Email'
            $row.priority | Should -Be 1
            $row.state | Should -Be 'enabled'
            $row.marking | Should -Contain 'header'
            $row.encryption.enabled | Should -BeTrue
            $row.encryption.protectionType | Should -Be 'Template'
            $row.encryption.templateId | Should -Be 'template-1'
            $row.encryption.rights | Should -Contain 'principal-a:VIEW'
            $row.encryption.offlineAccess | Should -BeTrue
        }

        It 'marks a label published when a publishing policy lists it' {
            $result = Get-PurviewLabels -TenantId 'tenant-a'

            $published = @($result.items | Where-Object { $_.id -eq 'label-1' })[0]
            $published.published | Should -BeTrue
            $published.publishingPolicies | Should -Contain 'Default Policy'

            $draft = @($result.items | Where-Object { $_.id -eq 'label-2' })[0]
            $draft.published | Should -BeFalse
            $draft.publishingPolicies | Should -HaveCount 0
        }

        It 'maps the disabled state and no-encryption label' {
            $result = Get-PurviewLabels -TenantId 'tenant-a'

            $row = @($result.items | Where-Object { $_.id -eq 'label-2' })[0]
            $row.state | Should -Be 'disabled'
            $row.encryption | Should -BeNullOrEmpty
            $row.marking | Should -HaveCount 0
        }

        It 'orders rows by priority then name' {
            $result = Get-PurviewLabels -TenantId 'tenant-a'

            @($result.items).id | Should -Be @('label-1', 'label-2')
        }

        It 'requires the tenant identifier' {
            { Get-PurviewLabels -TenantId '' } | Should -Throw
        }
    }

    Context 'SIT list mapping' {
        BeforeEach {
            script:New-PurviewLabelsMock
        }

        It 'returns the §3.4 columns with cursor paging metadata' {
            $result = Get-PurviewSits -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.kind | Should -Be 'sits'
            $result.items | Should -HaveCount 2
            $result.totalCount | Should -Be 2

            $row = @($result.items | Where-Object { $_.id -eq 'sit-1' })[0]
            $row.name | Should -Be 'Credit Card Number'
            $row.type | Should -Be 'builtin'
            $row.patternConfidence | Should -Be 'High'
            $row.basedOn | Should -BeNullOrEmpty
        }

        It 'maps a custom SIT and its base type' {
            $result = Get-PurviewSits -TenantId 'tenant-a'

            $row = @($result.items | Where-Object { $_.id -eq 'sit-2' })[0]
            $row.type | Should -Be 'custom'
            $row.patternConfidence | Should -Be 'Medium'
            $row.basedOn | Should -Be 'Credit Card Number'
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-PurviewLabelsMock
        }

        It 'searches label names case-insensitively and filters state' {
            (Get-PurviewLabels -TenantId 'tenant-a' -Search 'CONF').items | Should -HaveCount 1
            @(Get-PurviewLabels -TenantId 'tenant-a' -State 'enabled').items.id | Should -Be @('label-1')
            @(Get-PurviewLabels -TenantId 'tenant-a' -State 'disabled').items.id | Should -Be @('label-2')
        }

        It 'searches SIT names and filters type' {
            (Get-PurviewSits -TenantId 'tenant-a' -Search 'card').items | Should -HaveCount 1
            @(Get-PurviewSits -TenantId 'tenant-a' -Type 'custom').items.id | Should -Be @('sit-2')
            @(Get-PurviewSits -TenantId 'tenant-a' -Type 'builtin').items.id | Should -Be @('sit-1')
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-PurviewLabelsMock
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-PurviewLabels -TenantId 'tenant-a' -Top 1

            $first.items | Should -HaveCount 1
            $first.totalCount | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-PurviewLabels -TenantId 'tenant-a' -Top 1 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 1
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).id | Should -Be @('label-1', 'label-2')
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-PurviewSits -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-PurviewSits -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'sit-1'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id, kind, and payload filters' {
            $jobPath = Join-Path $TestDrive 'purview-labels-job.json'
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
                    filters       = @{ kind = 'sits'; type = 'custom'; top = 25 }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-PurviewLabelsJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Kind'] | Should -Be 'sits'
            $job['Type'] | Should -Be 'custom'
            $job['Top'] | Should -Be 25
            $job['Search'] | Should -Be ''
        }

        It 'defaults the kind to labels' {
            $jobPath = Join-Path $TestDrive 'purview-labels-job-default.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ filters = @{ search = 'conf' } }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-PurviewLabelsJob -Path $jobPath

            $job['Kind'] | Should -Be 'labels'
            $job['Search'] | Should -Be 'conf'
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'purview-labels-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-PurviewLabelsJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'purview-labels-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-PurviewLabelsJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-PurviewLabelsJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
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
