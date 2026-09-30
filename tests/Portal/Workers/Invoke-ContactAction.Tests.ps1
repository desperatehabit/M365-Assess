BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-ContactAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-contact-action.ps1'

    function global:Get-MailContact {
        param($Identity, $ErrorAction)
    }
    function global:Get-MailUser {
        param($Identity, $ErrorAction)
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

    $script:existingContact = @{
        ExchangeObjectId              = 'contact-1'
        DisplayName                   = 'Vendor Support'
        PrimarySmtpAddress            = 'vendor@example.invalid'
        ExternalEmailAddress          = 'smtp:vendor@example.invalid'
        RecipientTypeDetails          = 'MailContact'
        HiddenFromAddressListsEnabled = $false
    }
    $script:existingMailUser = @{
        ExchangeObjectId              = 'contact-2'
        DisplayName                   = 'External User'
        PrimarySmtpAddress            = 'external@example.invalid'
        ExternalEmailAddress          = 'smtp:external@example.invalid'
        RecipientTypeDetails          = 'MailUser'
        HiddenFromAddressListsEnabled = $true
    }
    $script:createdContact = @{
        ExchangeObjectId              = 'contact-new'
        DisplayName                   = 'New Vendor'
        PrimarySmtpAddress            = 'newvendor@example.invalid'
        ExternalEmailAddress          = 'smtp:newvendor@example.invalid'
        RecipientTypeDetails          = 'MailContact'
        HiddenFromAddressListsEnabled = $false
    }

    $script:contactState = @{
        'contact-1' = @{ Record = $script:existingContact; Kind = 'MailContact' }
        'contact-2' = @{ Record = $script:existingMailUser; Kind = 'MailUser' }
    }

    function script:Update-ContactState {
        param(
            [Parameter(Mandatory)]
            [string]$Identity,

            [object]$DisplayName,

            [object]$ExternalAddress,

            [object]$HiddenFromGal
        )

        $updated = $script:contactState[$Identity].Record.PSObject.Copy()
        if ($null -ne $DisplayName) { $updated.DisplayName = [string]$DisplayName }
        if ($null -ne $ExternalAddress) { $updated.ExternalEmailAddress = "smtp:$ExternalAddress" }
        if ($null -ne $HiddenFromGal) { $updated.HiddenFromAddressListsEnabled = [bool]$HiddenFromGal }
        $script:contactState[$Identity] = @{ Record = $updated; Kind = $script:contactState[$Identity].Kind }
        return $updated
    }

    function script:New-ContactMock {
        $script:contactState = @{
            'contact-1' = @{ Record = $script:existingContact; Kind = 'MailContact' }
            'contact-2' = @{ Record = $script:existingMailUser; Kind = 'MailUser' }
        }
        Mock Get-MailContact {
            param($Identity, $ErrorAction)
            if ($script:contactState.ContainsKey($Identity) -and $script:contactState[$Identity].Kind -eq 'MailContact') {
                return $script:contactState[$Identity].Record
            }
            throw 'Request_ResourceNotFound'
        }
        Mock Get-MailUser {
            param($Identity, $ErrorAction)
            if ($script:contactState.ContainsKey($Identity) -and $script:contactState[$Identity].Kind -eq 'MailUser') {
                return $script:contactState[$Identity].Record
            }
            throw 'Request_ResourceNotFound'
        }
        Mock New-MailContact {
            param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            return $script:createdContact
        }
        Mock New-MailUser {
            param($Name, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            return $script:createdContact
        }
        Mock Set-MailContact {
            param($Identity, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            return script:Update-ContactState -Identity $Identity -DisplayName $DisplayName -ExternalAddress $ExternalAddress -HiddenFromGal $HiddenFromAddressListsEnabled
        }
        Mock Set-MailUser {
            param($Identity, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
            return script:Update-ContactState -Identity $Identity -DisplayName $DisplayName -ExternalAddress $ExternalAddress -HiddenFromGal $HiddenFromAddressListsEnabled
        }
        Mock Remove-MailContact {
            param($Identity, $Confirm)
        }
        Mock Remove-MailUser {
            param($Identity, $Confirm)
        }
    }
}

Describe 'Invoke-ContactAction worker (T-0443)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-ContactAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ContactActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-ContactActions -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the section-3.1 action set and the confirmation set' {
            Get-ContactActions | Should -Be @('create', 'edit', 'hideFromGal', 'delete')
            Get-ContactActionConfirmation | Should -Be @('delete')
        }

        It 'writes with the typed EXO cmdlets only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'New-MailContact'
            $source | Should -Match 'New-MailUser'
            $source | Should -Match 'Set-MailContact'
            $source | Should -Match 'Set-MailUser'
            $source | Should -Match 'Remove-MailContact'
            $source | Should -Match 'Remove-MailUser'
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
            $entrySource | Should -Match 'Invoke-ContactAction\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-ContactActionJob -Path'
            $entrySource | Should -Match 'Invoke-ContactAction'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'action dispatch' {
        BeforeEach {
            script:New-ContactMock
        }

        It 'requires the tenant identifier' {
            { Invoke-ContactAction -TenantId '' -Action 'hideFromGal' -ContactId 'contact-1' } | Should -Throw
        }

        It 'refuses an unknown action with a structured error and no EXO call' {
            { Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-1' -Action 'wipeEverything' } | Should -Throw '*contacts.unknown_action*'
            Should -Invoke New-MailContact -Times 0 -Exactly
            Should -Invoke Remove-MailContact -Times 0 -Exactly
        }

        It 'requires confirmation for delete with no EXO call' {
            { Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-1' -Action 'delete' } | Should -Throw '*contacts.confirm_required*'
            Should -Invoke Remove-MailContact -Times 0 -Exactly
            Should -Invoke Remove-MailUser -Times 0 -Exactly
        }

        It 'plans a create with no EXO write on dry run' {
            $result = Invoke-ContactAction -TenantId 'tenant-a' -Action 'create' -DisplayName 'New Vendor' -ExternalAddress 'newvendor@example.invalid' -DryRun:$true

            $result.action | Should -Be 'create'
            $result.dryRun | Should -BeTrue
            $result.before | Should -BeNullOrEmpty
            $result.after.displayName | Should -Be 'New Vendor'
            $result.after.type | Should -Be 'mailContact'
            $result.requiresConfirmation | Should -BeFalse
            Should -Invoke New-MailContact -Times 0 -Exactly
            Should -Invoke New-MailUser -Times 0 -Exactly
        }

        It 'plans a delete with no EXO write on dry run' {
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-1' -Action 'delete' -Confirmed -DryRun:$true

            $result.action | Should -Be 'delete'
            $result.dryRun | Should -BeTrue
            $result.before.displayName | Should -Be 'Vendor Support'
            $result.requiresConfirmation | Should -BeTrue
            Should -Invoke Remove-MailContact -Times 0 -Exactly
        }

        It 'creates a mail contact with before/after capture and a success audit' {
            $script:audits = @()
            $result = Invoke-ContactAction -TenantId 'tenant-a' -Action 'create' -DisplayName 'New Vendor' -ExternalAddress 'newvendor@example.invalid' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.action | Should -Be 'create'
            $result.auditEvent.action | Should -Be 'contacts.action:create'
            $result.auditEvent.result | Should -Be 'success'
            $result.auditEvent.contactId | Should -Be 'contact-new'
            Should -Invoke New-MailContact -ParameterFilter { $DisplayName -eq 'New Vendor' -and $ExternalEmailAddress -eq 'newvendor@example.invalid' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
            $script:audits[0].after.id | Should -Be 'contact-new'
        }

        It 'creates a mail user through New-MailUser' {
            $result = Invoke-ContactAction -TenantId 'tenant-a' -Action 'create' -DisplayName 'External Person' -ExternalAddress 'person@example.invalid' -Type 'mailUser'

            $result.success | Should -BeTrue
            $result.plan.after.type | Should -Be 'mailUser'
            Should -Invoke New-MailUser -ParameterFilter { $DisplayName -eq 'External Person' }
            Should -Invoke New-MailContact -Times 0 -Exactly
        }

        It 'refuses a create without a display name or external address' {
            { Invoke-ContactAction -TenantId 'tenant-a' -Action 'create' -ExternalAddress 'newvendor@example.invalid' } | Should -Throw '*displayName*'
            { Invoke-ContactAction -TenantId 'tenant-a' -Action 'create' -DisplayName 'New Vendor' } | Should -Throw '*externalAddress*'
            Should -Invoke New-MailContact -Times 0 -Exactly
        }

        It 'edits a mail contact with before/after capture and a success audit' {
            $script:audits = @()
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-1' -Action 'edit' -DisplayName 'Renamed Vendor' -HiddenFromGal $true -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.before.displayName | Should -Be 'Vendor Support'
            $result.plan.after.hiddenFromGal | Should -BeTrue
            Should -Invoke Set-MailContact -ParameterFilter { $Identity -eq 'contact-1' -and $DisplayName -eq 'Renamed Vendor' -and $HiddenFromAddressListsEnabled -eq $true }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
        }

        It 'edits a mail user through Set-MailUser' {
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-2' -Action 'edit' -DisplayName 'Renamed External'

            $result.success | Should -BeTrue
            Should -Invoke Set-MailUser -ParameterFilter { $Identity -eq 'contact-2' }
            Should -Invoke Set-MailContact -Times 0 -Exactly
        }

        It 'hides a contact from the GAL with before/after capture and a success audit' {
            $script:audits = @()
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-1' -Action 'hideFromGal' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.before.hiddenFromGal | Should -BeFalse
            $result.plan.after.hiddenFromGal | Should -BeTrue
            Should -Invoke Set-MailContact -ParameterFilter { $Identity -eq 'contact-1' -and $HiddenFromAddressListsEnabled -eq $true }
            $script:audits | Should -HaveCount 1
            $script:audits[0].action | Should -Be 'contacts.action:hideFromGal'
        }

        It 'deletes a contact with confirmation and a success audit' {
            $script:audits = @()
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-1' -Action 'delete' -Confirmed -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.before.displayName | Should -Be 'Vendor Support'
            $result.auditEvent.action | Should -Be 'contacts.action:delete'
            Should -Invoke Remove-MailContact -ParameterFilter { $Identity -eq 'contact-1' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
        }

        It 'deletes a mail user through Remove-MailUser' {
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-2' -Action 'delete' -Confirmed

            $result.success | Should -BeTrue
            Should -Invoke Remove-MailUser -ParameterFilter { $Identity -eq 'contact-2' }
            Should -Invoke Remove-MailContact -Times 0 -Exactly
        }

        It 'fails with a clear error when the contact does not exist' {
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-9' -Action 'hideFromGal'

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'contact-9'
            Should -Invoke Set-MailContact -Times 0 -Exactly
        }

        It 'returns a per-action failure with a failure audit when EXO rejects the write' {
            Mock Set-MailContact {
                param($Identity, $DisplayName, $ExternalEmailAddress, $HiddenFromAddressListsEnabled)
                throw 'Authorization_RequestDenied'
            }
            $script:audits = @()
            $result = Invoke-ContactAction -TenantId 'tenant-a' -ContactId 'contact-1' -Action 'hideFromGal' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'Authorization_RequestDenied'
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'failure'
        }
    }

    Context 'job envelope' {
        It 'reads an action envelope with confirmation and dry-run flags' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("contact-action-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    correlationId = 'correlation-1'
                    payload       = @{ contactId = 'contact-1'; action = 'delete'; confirm = $true; dryRun = $false; actor = 'operator-1' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-ContactActionJob -Path $path

                $job['TenantId'] | Should -Be 'tenant-a'
                $job['ContactId'] | Should -Be 'contact-1'
                $job['Action'] | Should -Be 'delete'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeFalse
                $job['Actor'] | Should -Be 'operator-1'
                $job['CorrelationId'] | Should -Be 'correlation-1'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads a create envelope defaulting the type to mailContact' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("contact-action-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{ action = 'create'; displayName = 'New Vendor'; externalAddress = 'newvendor@example.invalid'; hiddenFromGal = $true }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-ContactActionJob -Path $path

                $job['Action'] | Should -Be 'create'
                $job['Type'] | Should -Be 'mailContact'
                $job['HiddenFromGal'] | Should -BeTrue
                $job['ContactId'] | Should -Be ''
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects a missing file, a bad schema version, and missing fields' {
            { Read-ContactActionJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'no-such-job.json') } | Should -Throw

            $badVersion = Join-Path ([System.IO.Path]::GetTempPath()) ("contact-action-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a'; payload = @{ action = 'delete' } } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            try {
                { Read-ContactActionJob -Path $badVersion } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $badVersion -Force -ErrorAction SilentlyContinue
            }

            $noAction = Join-Path ([System.IO.Path]::GetTempPath()) ("contact-action-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ contactId = 'contact-1' } } | ConvertTo-Json | Set-Content -LiteralPath $noAction -Encoding UTF8
            try {
                { Read-ContactActionJob -Path $noAction } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noAction -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
