BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Import-Contacts.ps1'
    $script:contactAction = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-ContactAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/import-contacts.ps1'

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
    function global:Set-MailContact {
        param($Identity, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
    }
    function global:Set-MailUser {
        param($Identity, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
    }
    function global:Remove-MailContact {
        param($Identity, $Confirm)
    }
    function global:Remove-MailUser {
        param($Identity, $Confirm)
    }

    . $script:worker
    . $script:contactAction
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:existingContacts = @(
        @{
            ExchangeObjectId              = 'contact-existing'
            DisplayName                   = 'Existing Vendor'
            PrimarySmtpAddress            = 'vendor@example.invalid'
            ExternalEmailAddress          = 'smtp:vendor@example.invalid'
            RecipientTypeDetails          = 'MailContact'
            HiddenFromAddressListsEnabled = $false
        }
    )
    $script:createdContact = @{
        ExchangeObjectId              = 'contact-new'
        DisplayName                   = 'New Vendor'
        PrimarySmtpAddress            = 'newvendor@example.invalid'
        ExternalEmailAddress          = 'smtp:newvendor@example.invalid'
        RecipientTypeDetails          = 'MailContact'
        HiddenFromAddressListsEnabled = $false
    }

    function script:New-ImportMock {
        $existing = @($script:existingContacts)
        $created = $script:createdContact
        Mock Get-MailContact {
            param($Identity, $ResultSize, $Properties, $ErrorAction)
            if ($Identity) {
                throw 'Request_ResourceNotFound'
            }
            return @($existing)
        }.GetNewClosure()
        Mock Get-MailUser {
            param($Identity, $ResultSize, $Properties, $ErrorAction)
            if ($Identity) {
                throw 'Request_ResourceNotFound'
            }
            return @()
        }
        Mock New-MailContact {
            param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            return $created
        }.GetNewClosure()
        Mock New-MailUser {
            param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            return $created
        }.GetNewClosure()
        Mock Set-MailContact {
            param($Identity, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
        }
        Mock Set-MailUser {
            param($Identity, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
        }
    }
}

Describe 'Import-Contacts worker (T-0444)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-ContactsImport -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ContactsImportJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertFrom-ContactImportCsv -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-ContactImportAddress -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'applies valid rows through the EPIC-006 contact executor and never evaluates strings as code' {
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
            $entrySource | Should -Match 'Import-Contacts\.ps1'
            $entrySource | Should -Match 'Invoke-ContactAction\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-ContactsImportJob -Path'
            $entrySource | Should -Match 'Invoke-ContactsImport'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'address validation' {
        It 'accepts SMTP addresses with or without the smtp: prefix and rejects malformed ones' {
            Test-ContactImportAddress -Address 'vendor@example.invalid' | Should -BeTrue
            Test-ContactImportAddress -Address 'smtp:vendor@example.invalid' | Should -BeTrue
            Test-ContactImportAddress -Address 'not-an-address' | Should -BeFalse
            Test-ContactImportAddress -Address 'vendor@example' | Should -BeFalse
            Test-ContactImportAddress -Address 'vendor @example.invalid' | Should -BeFalse
            Test-ContactImportAddress -Address '' | Should -BeFalse
        }

        It 'normalises case and strips the smtp: prefix for comparison' {
            ConvertTo-ContactImportAddress -Address 'SMTP:Vendor@Example.INVALID' | Should -Be 'vendor@example.invalid'
        }
    }

    Context 'CSV parsing' {
        It 'parses the import columns in file order' {
            $csv = "displayName,externalAddress,type`nNew Vendor,newvendor@example.invalid,mailContact`nExternal User,external@example.invalid,mailUser"
            $rows = ConvertFrom-ContactImportCsv -Csv $csv

            $rows | Should -HaveCount 2
            $rows[0].displayName | Should -Be 'New Vendor'
            $rows[0].externalAddress | Should -Be 'newvendor@example.invalid'
            $rows[1].type | Should -Be 'mailUser'
        }

        It 'rejects a CSV without the externalAddress column' {
            { ConvertFrom-ContactImportCsv -Csv "displayName`nNo Address" } | Should -Throw '*externalAddress*'
        }
    }

    Context 'per-row import' {
        BeforeEach {
            script:New-ImportMock
        }

        It 'returns one result per row, flagging invalid and duplicate rows without aborting the file' {
            $script:audits = @()
            $csv = @(
                'displayName,externalAddress,type'
                'New Vendor,newvendor@example.invalid,mailContact'
                'New Vendor,newvendor@example.invalid,mailContact'
                'Existing Vendor,vendor@example.invalid,mailContact'
                'Bad Address,not-an-address,mailContact'
            ) -join "`n"

            $result = Invoke-ContactsImport -TenantId 'tenant-a' -Csv $csv -Actor 'operator-1' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            @($result.rows.status) | Should -Be @('created', 'skipped-duplicate', 'skipped-duplicate', 'invalid')
            $result.rows[1].reason | Should -Be 'address appears earlier in this import'
            $result.rows[2].reason | Should -Be 'address already exists in the tenant'
            $result.rows[3].reason | Should -Match 'not a valid email address'
            $result.rows[0].contactId | Should -Be 'contact-new'
            $result.summary.total | Should -Be 4
            $result.summary.created | Should -Be 1
            $result.summary.skippedDuplicate | Should -Be 2
            $result.summary.invalid | Should -Be 1
            Should -Invoke New-MailContact -Times 1 -Exactly
            $script:audits | Should -HaveCount 1
            $script:audits[0].action | Should -Be 'contacts.action:create'
            $script:audits[0].result | Should -Be 'success'
        }

        It 'detects duplicates against multiple existing tenant contacts case-insensitively' {
            Mock Get-MailContact {
                param($Identity, $ResultSize, $Properties, $ErrorAction)
                if ($Identity) { throw 'Request_ResourceNotFound' }
                return @(
                    @{ ExternalEmailAddress = 'smtp:first@example.invalid'; RecipientTypeDetails = 'MailContact' }
                    @{ ExternalEmailAddress = 'smtp:second@example.invalid'; RecipientTypeDetails = 'MailContact' }
                )
            }
            $result = Invoke-ContactsImport -TenantId 'tenant-a' -Rows @(
                @{ displayName = 'First'; externalAddress = 'first@example.invalid' }
                @{ displayName = 'Second'; externalAddress = 'SECOND@example.invalid' }
                @{ displayName = 'New'; externalAddress = 'new@example.invalid' }
            ) -Preview

            @($result.rows.status) | Should -Be @('skipped-duplicate', 'skipped-duplicate', 'ready')
            $result.rows[1].reason | Should -Be 'address already exists in the tenant'
        }

        It 'previews every row with no tenant write and no audit' {
            $script:audits = @()
            $rows = @(
                @{ displayName = 'New Vendor'; externalAddress = 'newvendor@example.invalid' }
                @{ displayName = 'Existing Vendor'; externalAddress = 'vendor@example.invalid' }
                @{ displayName = 'Bad Address'; externalAddress = 'not-an-address' }
            )

            $result = Invoke-ContactsImport -TenantId 'tenant-a' -Rows $rows -Preview -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            @($result.rows.status) | Should -Be @('ready', 'skipped-duplicate', 'invalid')
            $result.preview | Should -BeTrue
            Should -Invoke New-MailContact -Times 0 -Exactly
            $script:audits | Should -HaveCount 0
        }

        It 'reports a per-row apply failure with a reason and still creates its siblings' {
            $script:audits = @()
            Mock New-MailContact {
                param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
                if ($DisplayName -eq 'Rejected Vendor') { throw 'Authorization_RequestDenied' }
                return $script:createdContact
            }
            $rows = @(
                @{ displayName = 'New Vendor'; externalAddress = 'newvendor@example.invalid' }
                @{ displayName = 'Rejected Vendor'; externalAddress = 'rejected@example.invalid' }
            )

            $result = Invoke-ContactsImport -TenantId 'tenant-a' -Rows $rows -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            @($result.rows.status) | Should -Be @('created', 'failed')
            $result.rows[1].reason | Should -Match 'Authorization_RequestDenied'
            $result.summary.failed | Should -Be 1
            $script:audits | Should -HaveCount 2
            @($script:audits.result) | Should -Contain 'failure'
        }

        It 'rejects an empty or oversized batch' {
            (Invoke-ContactsImport -TenantId 'tenant-a' -Rows @()).statusCode | Should -Be 400
            $many = 1..501 | ForEach-Object { @{ displayName = "V$_"; externalAddress = "v$_@example.invalid" } }
            (Invoke-ContactsImport -TenantId 'tenant-a' -Rows $many -Preview).message | Should -BeLike '*at most 500*'
        }

        It 'rejects a malformed CSV with a structured 400' {
            (Invoke-ContactsImport -TenantId 'tenant-a' -Csv "displayName`nNo Address").statusCode | Should -Be 400
        }
    }

    Context 'job envelope' {
        It 'reads the tenant, CSV body, preview, and audit fields' {
            $path = Join-Path $TestDrive 'contacts-import-job.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                correlationId = 'correlation-1'
                payload       = @{ csv = "externalAddress`nnewvendor@example.invalid"; preview = $true; actor = 'operator-1' }
            } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

            $job = Read-ContactsImportJob -Path $path

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Csv'] | Should -Be "externalAddress`nnewvendor@example.invalid"
            $job['Preview'] | Should -BeTrue
            $job['Actor'] | Should -Be 'operator-1'
            $job['CorrelationId'] | Should -Be 'correlation-1'
        }

        It 'reads a rows-array envelope' {
            $path = Join-Path $TestDrive 'contacts-import-rows.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ rows = @(@{ displayName = 'New Vendor'; externalAddress = 'newvendor@example.invalid' }) }
            } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

            $job = Read-ContactsImportJob -Path $path

            $job['Rows'] | Should -HaveCount 1
            $job['Rows'][0]['externalAddress'] | Should -Be 'newvendor@example.invalid'
        }

        It 'rejects a missing file, a bad schema version, and a missing tenant' {
            { Read-ContactsImportJob -Path (Join-Path $TestDrive 'no-such-job.json') } | Should -Throw '*not found*'

            $badVersion = Join-Path $TestDrive 'contacts-import-bad-version.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a'; payload = @{} } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            { Read-ContactsImportJob -Path $badVersion } | Should -Throw '*schemaVersion*'

            $noTenant = Join-Path $TestDrive 'contacts-import-no-tenant.json'
            @{ schemaVersion = 'v1'; tenantId = ''; payload = @{} } | ConvertTo-Json | Set-Content -LiteralPath $noTenant -Encoding UTF8
            { Read-ContactsImportJob -Path $noTenant } | Should -Throw '*tenantId*'
        }
    }

    Context 'Entrypoint' {
        It 'imports the job CSV and prints the per-row report as JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            script:New-ImportMock
            $path = Join-Path $TestDrive 'entrypoint-job.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                correlationId = 'correlation-1'
                payload       = @{ csv = "displayName,externalAddress`nEntry Vendor,newvendor@example.invalid"; actor = 'operator-1' }
            } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json

            $out.rows[0].status | Should -Be 'created'
            $out.rows[0].externalAddress | Should -Be 'newvendor@example.invalid'
            $out.summary.created | Should -Be 1
            Should -Invoke New-MailContact -Times 1 -Exactly
        }
    }
}
