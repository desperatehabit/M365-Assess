BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Deploy-ContactTemplate.ps1'
    $script:contactAction = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-ContactAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/deploy-contact-template.ps1'

    function global:Get-MailContact {
        param($Identity, $ResultSize, $Properties, $ErrorAction)
    }
    function global:Get-MailUser {
        param($Identity, $ResultSize, $Properties, $ErrorAction)
    }
    function global:New-MailContact {
        param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
    }
    function global:New-MailUser {
        param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
    }

    . $script:worker
    . $script:contactAction
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    function script:New-DeployMock {
        Mock New-MailContact {
            param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            if ($DisplayName -eq 'Rejected Vendor') { throw 'Authorization_RequestDenied' }
            return @{
                ExchangeObjectId              = "contact-$DisplayName"
                DisplayName                   = $DisplayName
                PrimarySmtpAddress            = $ExternalEmailAddress
                ExternalEmailAddress          = "smtp:$ExternalEmailAddress"
                RecipientTypeDetails          = 'MailContact'
                HiddenFromAddressListsEnabled = $HiddenFromAddressListsEnabled
            }
        }
        Mock New-MailUser {
            param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            if ($DisplayName -eq 'Rejected Vendor') { throw 'Authorization_RequestDenied' }
            return @{
                ExchangeObjectId              = "contact-$DisplayName"
                DisplayName                   = $DisplayName
                PrimarySmtpAddress            = $ExternalEmailAddress
                ExternalEmailAddress          = "smtp:$ExternalEmailAddress"
                RecipientTypeDetails          = 'MailUser'
                HiddenFromAddressListsEnabled = $HiddenFromAddressListsEnabled
            }
        }
        Mock Get-MailContact {
            param($Identity, $ResultSize, $Properties, $ErrorAction)
            throw 'Request_ResourceNotFound'
        }
        Mock Get-MailUser {
            param($Identity, $ResultSize, $Properties, $ErrorAction)
            throw 'Request_ResourceNotFound'
        }
    }

    $script:template = @{
        id         = 'tpl-vendor'
        name       = 'Vendor'
        properties = @{
            displayName     = '{name}'
            externalAddress = '{address}'
            type            = '{type}'
        }
        variables  = @{ type = 'mailContact'; address = 'default@example.invalid' }
    }
}

Describe 'Deploy-ContactTemplate worker (T-0447)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-DeployContactTemplate -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Resolve-ContactTemplateTarget -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Resolve-ContactTemplateProperties -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DeployContactTemplateJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'applies valid targets through the EPIC-006 contact executor and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-ContactAction'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'never persists contact data to disk, logs, or transcripts' {
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

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Deploy-ContactTemplate\.ps1'
            $entrySource | Should -Match 'Invoke-ContactAction\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-DeployContactTemplateJob -Path'
            $entrySource | Should -Match 'Invoke-DeployContactTemplate'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'variable resolution' {
        It 'substitutes target variables into the template properties and leaves unknown tokens intact' {
            $properties = Resolve-ContactTemplateProperties -Properties $script:template.properties -Variables @{ name = 'Acme'; address = 'acme@example.invalid'; type = 'mailUser' }
            $properties['displayName'] | Should -Be 'Acme'
            $properties['externalAddress'] | Should -Be 'acme@example.invalid'
            $properties['type'] | Should -Be 'mailUser'

            Resolve-ContactTemplateString -Value 'hello {unknown}' -Variables @{ name = 'Acme' } | Should -Be 'hello {unknown}'
        }

        It 'resolves a target using target overrides over template defaults' {
            $resolved = Resolve-ContactTemplateTarget -Template $script:template -Target @{
                tenantId  = 'tenant-a'
                variables = @{ name = 'Acme'; address = 'acme@example.invalid' }
            }
            $resolved.valid | Should -BeTrue
            $resolved.displayName | Should -Be 'Acme'
            $resolved.externalAddress | Should -Be 'acme@example.invalid'
            # `type` is not supplied by the target, so the template default wins.
            $resolved.type | Should -Be 'mailContact'
        }

        It 'flags a resolved target with a malformed address as invalid without throwing' {
            $resolved = Resolve-ContactTemplateTarget -Template $script:template -Target @{
                tenantId  = 'tenant-a'
                variables = @{ name = 'Bad'; address = 'not-an-address' }
            }
            $resolved.valid | Should -BeFalse
            ($resolved.issues -join '; ') | Should -Match 'not a valid email address'
        }
    }

    Context 'per-target deploy' {
        BeforeEach {
            script:New-DeployMock
        }

        It 'previews every resolved target with no tenant write and no audit' {
            $script:audits = @()
            $targets = @(
                @{ tenantId = 'tenant-a'; variables = @{ name = 'New Vendor'; address = 'new@example.invalid' } }
                @{ tenantId = 'tenant-b'; variables = @{ name = 'Bad Vendor'; address = 'not-an-address' } }
            )

            $result = Invoke-DeployContactTemplate -Template $script:template -Targets $targets -DryRun -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            @($result.targets.status) | Should -Be @('ready', 'invalid')
            $result.preview | Should -BeTrue
            $result.targets[1].reason | Should -Match 'not a valid email address'
            $result.state | Should -Be 'partial'
            Should -Invoke New-MailContact -Times 0 -Exactly
            $script:audits | Should -HaveCount 0
        }

        It 'reports a partial failure without hiding the successful target' {
            $script:audits = @()
            $targets = @(
                @{ tenantId = 'tenant-a'; variables = @{ name = 'New Vendor'; address = 'new@example.invalid' } }
                @{ tenantId = 'tenant-b'; variables = @{ name = 'Rejected Vendor'; address = 'rejected@example.invalid' } }
            )

            $result = Invoke-DeployContactTemplate -Template $script:template -Targets $targets -Actor 'operator-1' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            @($result.targets.status) | Should -Be @('created', 'failed')
            $result.targets[0].contactId | Should -Be 'contact-New Vendor'
            $result.targets[1].reason | Should -Match 'Authorization_RequestDenied'
            $result.state | Should -Be 'partial'
            $result.summary.created | Should -Be 1
            $result.summary.failed | Should -Be 1
            # Both the success and the failure are audited.
            $script:audits | Should -HaveCount 2
            @($script:audits.result) | Should -Contain 'success'
            @($script:audits.result) | Should -Contain 'failure'
        }

        It 'applies every valid target and audits each when all succeed' {
            $script:audits = @()
            $targets = @(
                @{ tenantId = 'tenant-a'; variables = @{ name = 'Acme'; address = 'acme@example.invalid' } }
                @{ tenantId = 'tenant-b'; variables = @{ name = 'Globex'; address = 'globex@example.invalid' } }
            )

            $result = Invoke-DeployContactTemplate -Template $script:template -Targets $targets -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            @($result.targets.status) | Should -Be @('created', 'created')
            $result.state | Should -Be 'succeeded'
            $result.summary.created | Should -Be 2
            Should -Invoke New-MailContact -Times 2 -Exactly
            $script:audits | Should -HaveCount 2
        }

        It 'does not abort siblings when one target is invalid' {
            $script:audits = @()
            $targets = @(
                @{ tenantId = 'tenant-a'; variables = @{ name = 'Bad'; address = 'not-an-address' } }
                @{ tenantId = 'tenant-b'; variables = @{ name = 'Acme'; address = 'acme@example.invalid' } }
            )

            $result = Invoke-DeployContactTemplate -Template $script:template -Targets $targets -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            @($result.targets.status) | Should -Be @('invalid', 'created')
            $result.state | Should -Be 'partial'
            $script:audits | Should -HaveCount 1
        }

        It 'rejects an empty target list with a structured 400' {
            $result = Invoke-DeployContactTemplate -Template $script:template -Targets @($null)
            $result.statusCode | Should -Be 400
        }
    }

    Context 'job envelope' {
        It 'reads the template, targets, dry-run, and audit fields' {
            $path = Join-Path $TestDrive 'contact-template-deploy-job.json'
            @{
                schemaVersion = 'v1'
                correlationId = 'correlation-1'
                payload       = @{
                    template = $script:template
                    targets  = @(@{ tenantId = 'tenant-a'; variables = @{ name = 'Acme'; address = 'acme@example.invalid' } })
                    dryRun   = $true
                    actor    = 'operator-1'
                }
            } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8

            $job = Read-DeployContactTemplateJob -Path $path

            $job['Template'].id | Should -Be 'tpl-vendor'
            $job['Targets'] | Should -HaveCount 1
            $job['Targets'][0]['tenantId'] | Should -Be 'tenant-a'
            $job['DryRun'] | Should -BeTrue
            $job['Actor'] | Should -Be 'operator-1'
            $job['CorrelationId'] | Should -Be 'correlation-1'
        }

        It 'falls back to a single tenantId with shared variables' {
            $path = Join-Path $TestDrive 'contact-template-deploy-single.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ template = $script:template; variables = @{ name = 'Acme'; address = 'acme@example.invalid' } }
            } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8

            $job = Read-DeployContactTemplateJob -Path $path

            $job['Targets'] | Should -HaveCount 1
            $job['Targets'][0]['variables']['name'] | Should -Be 'Acme'
        }

        It 'rejects a missing file, a bad schema version, a missing template, and missing targets' {
            { Read-DeployContactTemplateJob -Path (Join-Path $TestDrive 'no-such-job.json') } | Should -Throw '*not found*'

            $badVersion = Join-Path $TestDrive 'contact-template-deploy-bad-version.json'
            @{ schemaVersion = 'v9'; payload = @{ template = $script:template; targets = @(@{ tenantId = 'tenant-a' }) } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $badVersion -Encoding UTF8
            { Read-DeployContactTemplateJob -Path $badVersion } | Should -Throw '*schemaVersion*'

            $noTemplate = Join-Path $TestDrive 'contact-template-deploy-no-template.json'
            @{ schemaVersion = 'v1'; payload = @{ targets = @(@{ tenantId = 'tenant-a' }) } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $noTemplate -Encoding UTF8
            { Read-DeployContactTemplateJob -Path $noTemplate } | Should -Throw '*payload.template*'

            $noTargets = Join-Path $TestDrive 'contact-template-deploy-no-targets.json'
            @{ schemaVersion = 'v1'; payload = @{ template = $script:template } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $noTargets -Encoding UTF8
            { Read-DeployContactTemplateJob -Path $noTargets } | Should -Throw '*payload.targets*'
        }
    }

    Context 'Entrypoint' {
        It 'deploys the job targets and prints the per-target report as JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            script:New-DeployMock
            $path = Join-Path $TestDrive 'entrypoint-deploy-job.json'
            @{
                schemaVersion = 'v1'
                correlationId = 'correlation-1'
                payload       = @{
                    template = $script:template
                    targets  = @(
                        @{ tenantId = 'tenant-a'; variables = @{ name = 'Acme'; address = 'acme@example.invalid' } }
                        @{ tenantId = 'tenant-b'; variables = @{ name = 'Rejected Vendor'; address = 'rejected@example.invalid' } }
                    )
                    actor    = 'operator-1'
                }
            } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8

            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json

            @($out.targets.status) | Should -Be @('created', 'failed')
            $out.summary.created | Should -Be 1
            $out.summary.failed | Should -Be 1
            $out.state | Should -Be 'partial'
            Should -Invoke New-MailContact -Times 2 -Exactly
        }
    }
}
