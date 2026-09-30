BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-MessageEncryption.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-message-encryption.ps1'

    function global:Get-IRMConfiguration {
    }
    function global:Get-OMEConfiguration {
        param([string]$Identity)
    }
    function global:Set-OMEConfiguration {
        param([string]$Identity)
    }

    . $script:worker

    $script:irmRecord = @{
        Identity                     = 'tenant-a'
        AzureRMSLicensingEnabled    = $true
        InternalLicensingEnabled    = $true
        ExternalLicensingEnabled    = $false
    }
    $script:omeRecord = @{
        Identity                 = 'Default'
        ExternalMailExpiryInDays = 7
        PortalText               = 'This message is confidential.'
        DisclaimerText           = 'Do not forward.'
        EmailText                = 'Encrypted message'
        ReadButtonText           = 'Read'
        IntroductionText         = 'You received an encrypted message.'
    }

    function script:New-EncryptionMock {
        Mock Get-IRMConfiguration { return $script:irmRecord }
        Mock Get-OMEConfiguration { return $script:omeRecord }
        Mock Set-OMEConfiguration { return $null }
    }
}

Describe 'Get-MessageEncryption worker (T-0469)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-MessageEncryption -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-MessageEncryptionTemplate -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'the read path issues Get- cmdlets only and never writes to the tenant' {
            New-EncryptionMock

            $null = Get-MessageEncryption -TenantId 'tenant-a'

            Assert-MockCalled Get-IRMConfiguration -Exactly 1
            Assert-MockCalled Get-OMEConfiguration -Exactly 1
            Assert-MockCalled Set-OMEConfiguration -Exactly 0
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-MessageEncryption\.ps1'
            $entrySource | Should -Match 'Invoke-MessageEncryptionTemplate'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'message encryption retrieval' {
        BeforeEach {
            New-EncryptionMock
        }

        It 'returns the shaped IRM configuration and OME templates' {
            $result = Get-MessageEncryption -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.irmConfiguration.identity | Should -Be 'tenant-a'
            $result.irmConfiguration.azureRmsLicensingEnabled | Should -BeTrue
            $result.irmConfiguration.internalLicensingEnabled | Should -BeTrue
            $result.irmConfiguration.externalLicensingEnabled | Should -BeFalse
            $result.omeTemplates.Count | Should -Be 1
            $result.omeTemplates[0].identity | Should -Be 'Default'
            $result.omeTemplates[0].externalMailExpiryInDays | Should -Be 7
            $result.omeTemplates[0].portalText | Should -Be 'This message is confidential.'
            $result.retrievedAt | Should -Not -BeNullOrEmpty
        }

        It 'reports missing IRM flags as disabled instead of failing' {
            Mock Get-IRMConfiguration { return @{ Identity = 'tenant-a' } }

            $result = Get-MessageEncryption -TenantId 'tenant-a'

            $result.irmConfiguration.azureRmsLicensingEnabled | Should -BeFalse
            $result.irmConfiguration.internalLicensingEnabled | Should -BeFalse
            $result.irmConfiguration.externalLicensingEnabled | Should -BeFalse
        }

        It 'throws a structured error when the IRM configuration is unavailable' {
            Mock Get-IRMConfiguration { return $null }

            { Get-MessageEncryption -TenantId 'tenant-a' } | Should -Throw '*config_not_found*'
        }
    }

    Context 'gated OME template apply' {
        BeforeEach {
            New-EncryptionMock
        }

        It 'dry run returns the plan without writing to the tenant' {
            $plan = Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Default' -Settings @{ portalText = 'Updated portal text.' } -DryRun:$true

            $plan.action | Should -Be 'ome-template-apply'
            $plan.templateId | Should -Be 'Default'
            $plan.dryRun | Should -BeTrue
            $plan.requiresConfirmation | Should -BeTrue
            $plan.before.portalText | Should -Be 'This message is confidential.'
            $plan.after.portalText | Should -Be 'Updated portal text.'
            $plan.diff -join ';' | Should -Match 'portalText'
            Assert-MockCalled Set-OMEConfiguration -Exactly 0
        }

        It 'apply without confirmation throws a structured error' {
            { Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Default' -Settings @{ portalText = 'Updated portal text.' } } |
                Should -Throw '*confirm_required*'
            Assert-MockCalled Set-OMEConfiguration -Exactly 0
        }

        It 'apply with confirmation writes the change and captures before/after plus audit' {
            $result = Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Default' -Settings @{ portalText = 'Updated portal text.' } -Confirmed:$true

            $result.success | Should -BeTrue
            $result.plan.dryRun | Should -BeFalse
            $result.plan.requiresConfirmation | Should -BeFalse
            $result.plan.before.portalText | Should -Be 'This message is confidential.'
            $result.plan.after.portalText | Should -Be 'Updated portal text.'
            $result.auditEvent.action | Should -Be 'mail.encryption_template.apply'
            $result.auditEvent.tenantId | Should -Be 'tenant-a'
            $result.auditEvent.targetId | Should -Be 'Default'
            $result.auditEvent.before.portalText | Should -Be 'This message is confidential.'
            $result.auditEvent.after.portalText | Should -Be 'Updated portal text.'
            Assert-MockCalled Set-OMEConfiguration -Exactly 1
        }

        It 'apply validates the external mail expiry as a non-negative integer' {
            { Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Default' -Settings @{ externalMailExpiryInDays = 'soon' } -Confirmed:$true } |
                Should -Throw '*invalid_setting*'
            Assert-MockCalled Set-OMEConfiguration -Exactly 0
        }

        It 'apply rejects unsupported settings' {
            { Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Default' -Settings @{ bogus = 'x' } -Confirmed:$true } |
                Should -Throw '*unsupported_setting*'
            Assert-MockCalled Set-OMEConfiguration -Exactly 0
        }

        It 'apply without settings throws a structured error' {
            { Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Default' -Settings @{} -Confirmed:$true } |
                Should -Throw '*no_settings*'
            Assert-MockCalled Set-OMEConfiguration -Exactly 0
        }

        It 'apply for an unknown template throws a structured NotFound error' {
            Mock Get-OMEConfiguration { return $null }

            { Invoke-MessageEncryptionTemplate -TenantId 'tenant-a' -TemplateId 'Nope' -Settings @{ portalText = 'Updated portal text.' } -Confirmed:$true } |
                Should -Throw '*template_not_found*'
            Assert-MockCalled Set-OMEConfiguration -Exactly 0
        }
    }

    Context 'job envelope parsing' {
        It 'reads tenant, action, template, settings, and flags from the envelope' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('message-encryption-job-{0}.json' -f [guid]::NewGuid())
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    action        = 'apply'
                    payload       = @{
                        templateId = 'Default'
                        settings  = @{ portalText = 'Updated portal text.' }
                        dryRun    = $true
                        confirmed = $false
                    }
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-MessageEncryptionJob -Path $path
                $job['TenantId'] | Should -Be 'tenant-a'
                $job['Action'] | Should -Be 'apply'
                $job['TemplateId'] | Should -Be 'Default'
                $job['Settings']['portalText'] | Should -Be 'Updated portal text.'
                $job['DryRun'] | Should -BeTrue
                $job['Confirmed'] | Should -BeFalse
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'defaults the action to read when the envelope omits it' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('message-encryption-job-{0}.json' -f [guid]::NewGuid())
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-MessageEncryptionJob -Path $path
                $job['Action'] | Should -Be 'read'
                $job['TemplateId'] | Should -Be ''
                $job['Settings'].Count | Should -Be 0
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects an envelope without a tenant' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('message-encryption-job-{0}.json' -f [guid]::NewGuid())
            try {
                @{
                    schemaVersion = 'v1'
                    payload       = @{}
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8

                { Read-MessageEncryptionJob -Path $path } | Should -Throw '*tenantId*'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
