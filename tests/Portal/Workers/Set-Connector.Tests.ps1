BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-Connector.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-connector.ps1'

    $global:connectorSecretMaterial = '-----BEGIN CERTIFICATE-----partner-tls-material-----END CERTIFICATE-----'
    $global:connectorSecretRef = 'ref://tenants/tenant-a/connector-secret/abc-123'
    $global:resolvedSecretRef = $null

    function global:Get-InboundConnector {
        param($Identity)
    }
    function global:Get-OutboundConnector {
        param($Identity)
    }
    function global:New-InboundConnector {
        param($Name, $SenderDomains, $RequireTls, $Enabled, $TlsCertificate)
    }
    function global:Set-InboundConnector {
        param($Identity, $Name, $Enabled, $SenderDomains, $RecipientDomains, $RequireTls, $TlsCertificate)
    }
    function global:Remove-InboundConnector {
        param($Identity, $Confirm)
    }
    function global:New-OutboundConnector {
        param($Name, $RecipientDomains, $RequireTls, $Enabled, $TlsCertificate)
    }
    function global:Set-OutboundConnector {
        param($Identity, $Name, $Enabled, $SenderDomains, $RecipientDomains, $RequireTls, $TlsCertificate)
    }
    function global:Remove-OutboundConnector {
        param($Identity, $Confirm)
    }

    . $script:worker

    $script:partnerInbound = @{
        Identity         = 'conn-in-1'
        Name             = 'Partner inbound'
        ConnectorType    = 'Inbound'
        Enabled          = $true
        SenderDomains    = @('partner.example.invalid')
        RecipientDomains = @()
        RequireTls       = $true
        WhenChangedUTC   = '2026-09-20T12:00:00Z'
    }

    $script:disabledInbound = @{
        Identity         = 'conn-in-2'
        Name             = 'Legacy inbound'
        ConnectorType    = 'Inbound'
        Enabled          = $false
        SenderDomains    = @('legacy.example.invalid')
        RecipientDomains = @()
        RequireTls       = $false
        WhenChangedUTC   = '2026-09-10T09:00:00Z'
    }

    $script:partnerOutbound = @{
        Identity         = 'conn-out-1'
        Name             = 'Partner outbound'
        ConnectorType    = 'Outbound'
        Enabled          = $false
        SenderDomains    = @()
        RecipientDomains = @('partner.example.invalid')
        RequireTls       = $false
        WhenChangedUTC   = '2026-09-18T08:00:00Z'
    }

    function script:New-CredentialStore {
        $global:resolvedSecretRef = $null
        return {
            param($Ref)
            $global:resolvedSecretRef = $Ref
            return $global:connectorSecretMaterial
        }
    }
}

Describe 'Set-Connector worker (T-0404)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetConnector -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetConnectorJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-ConnectorInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-ConnectorChangeSensitive -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-ConnectorSnapshot -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Find-Connector -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Set-Connector\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-SetConnectorJob -Path'
            $entrySource | Should -Match 'Invoke-SetConnector @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }

        It 'never persists connector state or secret material to disk' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
        }
    }

    Context 'input validation' {
        It 'accepts a valid create' {
            $errors = @(Test-ConnectorInput -Action 'create' -Name 'Partner inbound' -Type 'inbound')
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects a create without a name' {
            $errors = @(Test-ConnectorInput -Action 'create' -Type 'inbound')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'name is required'
        }

        It 'rejects edit, enable, disable, and delete without a connector id' {
            foreach ($action in @('edit', 'enable', 'disable', 'delete')) {
                $errors = @(Test-ConnectorInput -Action $action -Name 'Renamed')
                $errors | Should -Not -BeNullOrEmpty
                $errors[0] | Should -Match 'connectorId is required'
            }
        }

        It 'rejects an edit with no field to change' {
            $errors = @(Test-ConnectorInput -Action 'edit' -ConnectorId 'conn-in-1')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'at least one connector field'
        }
    }

    Context 'mail-flow sensitivity classification' {
        It 'flags a disable of an enabled connector with the warning path' {
            $guard = Test-ConnectorChangeSensitive -Action 'disable' -Before @{ enabled = $true }
            $guard.securitySensitive | Should -BeTrue
            $guard.requiresConfirmation | Should -BeTrue
            $guard.warning | Should -Match 'production mail flow'
            $guard.reasons | Should -Not -BeNullOrEmpty
        }

        It 'leaves a disable of an already-disabled connector off the warning path' {
            $guard = Test-ConnectorChangeSensitive -Action 'disable' -Before @{ enabled = $false }
            $guard.securitySensitive | Should -BeFalse
            $guard.requiresConfirmation | Should -BeFalse
        }

        It 'flags a delete of an enabled connector' {
            $guard = Test-ConnectorChangeSensitive -Action 'delete' -Before @{ enabled = $true }
            $guard.securitySensitive | Should -BeTrue
            $guard.warning | Should -Match 'production mail flow'
        }

        It 'leaves a delete of a disabled connector off the warning path' {
            $guard = Test-ConnectorChangeSensitive -Action 'delete' -Before @{ enabled = $false }
            $guard.securitySensitive | Should -BeFalse
        }

        It 'flags an edit that disables the connector' {
            $guard = Test-ConnectorChangeSensitive -Action 'edit' -Before @{ enabled = $true } -After @{ enabled = $false }
            $guard.securitySensitive | Should -BeTrue
            $guard.warning | Should -Match 'production mail flow'
        }

        It 'leaves a rename or an enable off the warning path' {
            $guard = Test-ConnectorChangeSensitive -Action 'edit' -Before @{ enabled = $true } -After @{ enabled = $true }
            $guard.securitySensitive | Should -BeFalse
            $guard = Test-ConnectorChangeSensitive -Action 'enable' -After @{ enabled = $true }
            $guard.securitySensitive | Should -BeFalse
        }
    }

    Context 'connector snapshot mapping' {
        It 'maps an inbound connector to the before/after shape' {
            $snapshot = ConvertTo-ConnectorSnapshot -Connector $script:partnerInbound
            $snapshot['identity'] | Should -Be 'conn-in-1'
            $snapshot['name'] | Should -Be 'Partner inbound'
            $snapshot['type'] | Should -Be 'inbound'
            $snapshot['enabled'] | Should -BeTrue
            $snapshot['senderDomains'] | Should -Contain 'partner.example.invalid'
            $snapshot['requireTls'] | Should -BeTrue
            $snapshot['secretRef'] | Should -BeNullOrEmpty
            $snapshot['lastModified'] | Should -Be '2026-09-20T12:00:00Z'
        }

        It 'maps an outbound connector and falls back to WhenChanged' {
            $snapshot = ConvertTo-ConnectorSnapshot -Connector $script:partnerOutbound
            $snapshot['type'] | Should -Be 'outbound'
            $snapshot['enabled'] | Should -BeFalse
            $snapshot['recipientDomains'] | Should -Contain 'partner.example.invalid'
            $snapshot['lastModified'] | Should -Be '2026-09-18T08:00:00Z'
        }
    }

    Context 'connector lookup' {
        It 'finds a connector by name on the inbound set without consulting outbound' {
            Mock Get-InboundConnector {
                param($Identity)
                return @($script:partnerInbound)
            }
            Mock Get-OutboundConnector {
                param($Identity)
                return @()
            }

            $found = Find-Connector -ConnectorId 'Partner inbound'

            $found | Should -Not -BeNullOrEmpty
            $found.Identity | Should -Be 'conn-in-1'
            Assert-MockCalled Get-InboundConnector -Times 1
            Assert-MockCalled Get-OutboundConnector -Times 0
        }

        It 'falls through to the outbound set when inbound has no match' {
            Mock Get-InboundConnector {
                param($Identity)
                return @()
            }
            Mock Get-OutboundConnector {
                param($Identity)
                return @($script:partnerOutbound)
            }

            $found = Find-Connector -ConnectorId 'conn-out-1'

            $found | Should -Not -BeNullOrEmpty
            $found.Name | Should -Be 'Partner outbound'
            Assert-MockCalled Get-OutboundConnector -Times 1
        }

        It 'returns null when no connector matches' {
            Mock Get-InboundConnector {
                param($Identity)
                return @()
            }
            Mock Get-OutboundConnector {
                param($Identity)
                return @()
            }

            $found = Find-Connector -ConnectorId 'missing'

            $found | Should -BeNullOrEmpty
        }
    }

    Context 'connector create' {
        BeforeEach {
            Mock New-InboundConnector {
                param($Name, $SenderDomains, $RequireTls, $Enabled, $TlsCertificate)
                return @{ Identity = 'conn-new'; Name = $Name }
            }
        }

        It 'create with DryRun returns a plan preview without calling New-InboundConnector' {
            $plan = Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner inbound' -Type 'inbound' -SenderDomains 'partner.example.invalid' -DryRun $true

            $plan.action | Should -Be 'create'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.targetName | Should -Be 'Partner inbound'
            $plan.before | Should -BeNullOrEmpty
            $plan.after['name'] | Should -Be 'Partner inbound'
            $plan.after['type'] | Should -Be 'inbound'
            $plan.after['senderDomains'] | Should -Contain 'partner.example.invalid'
            $plan.after['enabled'] | Should -BeTrue
            $plan.securitySensitive | Should -BeFalse
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled New-InboundConnector -Times 0
        }

        It 'create apply without confirmation is refused' {
            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner inbound' -Type 'inbound' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled New-InboundConnector -Times 0
        }

        It 'create apply with confirmation calls New-InboundConnector and produces an audit record' {
            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner inbound' -Type 'inbound' -SenderDomains 'partner.example.invalid' -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.result['id'] | Should -Be 'conn-new'
            $res.plan.before | Should -BeNullOrEmpty
            $res.plan.after['name'] | Should -Be 'Partner inbound'
            $res.plan.dryRun | Should -BeFalse
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'connector.create'
            $res.auditEvent.targetId | Should -Be 'conn-new'
            $res.auditEvent.before | Should -BeNullOrEmpty
            $res.auditEvent.after['name'] | Should -Be 'Partner inbound'
            Assert-MockCalled New-InboundConnector -Times 1 -ParameterFilter { $Name -eq 'Partner inbound' }
        }

        It 'create with a missing name throws before any write' {
            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Type 'inbound' -DryRun $true
            } | Should -Throw '*ValidationFailed*'
            Assert-MockCalled New-InboundConnector -Times 0
        }

        It 'outbound create calls New-OutboundConnector' {
            Mock New-OutboundConnector {
                param($Name, $RecipientDomains, $RequireTls, $Enabled, $TlsCertificate)
                return @{ Identity = 'conn-out-new'; Name = $Name }
            }

            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner outbound' -Type 'outbound' -RecipientDomains 'partner.example.invalid' -RequireTls $true -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.result['id'] | Should -Be 'conn-out-new'
            $res.plan.after['type'] | Should -Be 'outbound'
            $res.plan.after['recipientDomains'] | Should -Contain 'partner.example.invalid'
            $res.plan.after['requireTls'] | Should -BeTrue
            Assert-MockCalled New-OutboundConnector -Times 1
            Assert-MockCalled New-InboundConnector -Times 0
        }
    }

    Context 'connector edit, enable, and disable' {
        BeforeEach {
            $script:liveConnector = $script:partnerInbound.Clone()
            Mock Get-InboundConnector {
                param($Identity)
                return @($script:liveConnector)
            }
            Mock Get-OutboundConnector {
                param($Identity)
                return @()
            }
            Mock Set-InboundConnector {
                param($Identity, $Name, $Enabled, $SenderDomains, $RecipientDomains, $RequireTls, $TlsCertificate)
                if ($PSBoundParameters.ContainsKey('Name')) { $script:liveConnector['Name'] = $Name }
                if ($PSBoundParameters.ContainsKey('Enabled')) { $script:liveConnector['Enabled'] = $Enabled }
                if ($PSBoundParameters.ContainsKey('SenderDomains')) { $script:liveConnector['SenderDomains'] = $SenderDomains }
                if ($PSBoundParameters.ContainsKey('RecipientDomains')) { $script:liveConnector['RecipientDomains'] = $RecipientDomains }
                if ($PSBoundParameters.ContainsKey('RequireTls')) { $script:liveConnector['RequireTls'] = $RequireTls }
                return @{ Identity = $Identity }
            }
        }

        It 'edit with DryRun returns a diff against the current connector without writing' {
            $plan = Invoke-SetConnector -TenantId 'tenant-a' -Action 'edit' -ConnectorId 'conn-in-1' -Name 'Partner inbound v2' -DryRun $true

            $plan.action | Should -Be 'edit'
            $plan.dryRun | Should -BeTrue
            $plan.before['name'] | Should -Be 'Partner inbound'
            $plan.after['name'] | Should -Be 'Partner inbound v2'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled Set-InboundConnector -Times 0
        }

        It 'edit that changes nothing is a structured no-op with no write' {
            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'edit' -ConnectorId 'conn-in-1' -Name 'Partner inbound' -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.noop | Should -BeTrue
            $res.result['noop'] | Should -BeTrue
            $res.plan.before['name'] | Should -Be 'Partner inbound'
            $res.plan.after['name'] | Should -Be 'Partner inbound'
            Assert-MockCalled Set-InboundConnector -Times 0
        }

        It 'edit apply without confirmation is refused' {
            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'edit' -ConnectorId 'conn-in-1' -Name 'Renamed' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-InboundConnector -Times 0
        }

        It 'edit apply captures before/after and produces an audit record' {
            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'edit' -ConnectorId 'conn-in-1' -Name 'Renamed' -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.noop | Should -BeNullOrEmpty
            $res.plan.before['name'] | Should -Be 'Partner inbound'
            $res.plan.after['name'] | Should -Be 'Renamed'
            $res.auditEvent.action | Should -Be 'connector.edit'
            $res.auditEvent.targetId | Should -Be 'conn-in-1'
            $res.auditEvent.before['name'] | Should -Be 'Partner inbound'
            $res.auditEvent.after['name'] | Should -Be 'Renamed'
            Assert-MockCalled Set-InboundConnector -Times 1 -ParameterFilter { $Identity -eq 'conn-in-1' -and $Name -eq 'Renamed' }
        }

        It 'disable apply warns, sets Enabled false, and audits before/after' {
            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'disable' -ConnectorId 'conn-in-1' -Enabled $false -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.plan.securitySensitive | Should -BeTrue
            $res.plan.requiresConfirmation | Should -BeTrue
            $res.plan.warning | Should -Match 'production mail flow'
            $res.plan.before['enabled'] | Should -BeTrue
            $res.plan.after['enabled'] | Should -BeFalse
            $res.auditEvent.action | Should -Be 'connector.disable'
            $res.auditEvent.before['enabled'] | Should -BeTrue
            $res.auditEvent.after['enabled'] | Should -BeFalse
            Assert-MockCalled Set-InboundConnector -Times 1 -ParameterFilter { $Enabled -eq $false }
        }

        It 'disable apply without confirmation is refused' {
            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'disable' -ConnectorId 'conn-in-1' -Enabled $false -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-InboundConnector -Times 0
        }

        It 'enable apply sets Enabled true without the mail-flow warning' {
            $script:liveConnector = $script:disabledInbound.Clone()

            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'enable' -ConnectorId 'conn-in-2' -Enabled $true -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.plan.securitySensitive | Should -BeFalse
            $res.plan.before['enabled'] | Should -BeFalse
            $res.plan.after['enabled'] | Should -BeTrue
            $res.auditEvent.action | Should -Be 'connector.enable'
            Assert-MockCalled Set-InboundConnector -Times 1 -ParameterFilter { $Enabled -eq $true }
        }

        It 'edit of an unknown connector throws NotFound' {
            Mock Get-InboundConnector {
                param($Identity)
                return @()
            }

            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'edit' -ConnectorId 'conn-missing' -Name 'Renamed' -DryRun $true
            } | Should -Throw '*NotFound*'
            Assert-MockCalled Set-InboundConnector -Times 0
        }

        It 'outbound edit calls Set-OutboundConnector' {
            $script:liveConnector = $script:partnerOutbound.Clone()
            Mock Get-InboundConnector {
                param($Identity)
                return @()
            }
            Mock Get-OutboundConnector {
                param($Identity)
                return @($script:liveConnector)
            }
            Mock Set-OutboundConnector {
                param($Identity, $Name, $Enabled, $SenderDomains, $RecipientDomains, $RequireTls, $TlsCertificate)
                if ($PSBoundParameters.ContainsKey('Name')) { $script:liveConnector['Name'] = $Name }
                if ($PSBoundParameters.ContainsKey('Enabled')) { $script:liveConnector['Enabled'] = $Enabled }
                if ($PSBoundParameters.ContainsKey('SenderDomains')) { $script:liveConnector['SenderDomains'] = $SenderDomains }
                if ($PSBoundParameters.ContainsKey('RecipientDomains')) { $script:liveConnector['RecipientDomains'] = $RecipientDomains }
                if ($PSBoundParameters.ContainsKey('RequireTls')) { $script:liveConnector['RequireTls'] = $RequireTls }
                return @{ Identity = $Identity }
            }

            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'edit' -ConnectorId 'conn-out-1' -Name 'Partner outbound v2' -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.plan.before['type'] | Should -Be 'outbound'
            $res.plan.after['name'] | Should -Be 'Partner outbound v2'
            Assert-MockCalled Set-OutboundConnector -Times 1
            Assert-MockCalled Set-InboundConnector -Times 0
        }
    }

    Context 'connector delete' {
        BeforeEach {
            Mock Get-InboundConnector {
                param($Identity)
                return @($script:partnerInbound)
            }
            Mock Get-OutboundConnector {
                param($Identity)
                return @()
            }
            Mock Remove-InboundConnector {
                param($Identity, $Confirm)
                return $null
            }
        }

        It 'delete with DryRun returns a plan without removing' {
            $plan = Invoke-SetConnector -TenantId 'tenant-a' -Action 'delete' -ConnectorId 'conn-in-1' -DryRun $true

            $plan.action | Should -Be 'delete'
            $plan.dryRun | Should -BeTrue
            $plan.before['name'] | Should -Be 'Partner inbound'
            $plan.securitySensitive | Should -BeTrue
            $plan.requiresConfirmation | Should -BeTrue
            $plan.warning | Should -Match 'production mail flow'
            Assert-MockCalled Remove-InboundConnector -Times 0
        }

        It 'delete apply without confirmation is refused' {
            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'delete' -ConnectorId 'conn-in-1' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Remove-InboundConnector -Times 0
        }

        It 'delete apply with confirmation removes and audits before/after' {
            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'delete' -ConnectorId 'conn-in-1' -DryRun $false -Confirmed $true

            $res.success | Should -BeTrue
            $res.result['deleted'] | Should -BeTrue
            $res.plan.before['name'] | Should -Be 'Partner inbound'
            $res.plan.after | Should -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'connector.delete'
            $res.auditEvent.before['name'] | Should -Be 'Partner inbound'
            Assert-MockCalled Remove-InboundConnector -Times 1 -ParameterFilter { $Identity -eq 'conn-in-1' }
        }
    }

    Context 'connector secret handling' {
        BeforeEach {
            Mock New-InboundConnector {
                param($Name, $SenderDomains, $RequireTls, $Enabled, $TlsCertificate)
                return @{ Identity = 'conn-new'; Name = $Name }
            }
        }

        It 'refuses a secret reference without a credential store' {
            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner inbound' -Type 'inbound' -SecretRef $global:connectorSecretRef -DryRun $true
            } | Should -Throw '*credential_store_required*'
            Assert-MockCalled New-InboundConnector -Times 0
        }

        It 'refuses an unresolvable secret reference' {
            $store = { param($Ref) return $null }

            {
                Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner inbound' -Type 'inbound' -SecretRef $global:connectorSecretRef -CredentialStore $store -DryRun $true
            } | Should -Throw '*credential_not_found*'
        }

        It 'resolves material inside the child and emits only the reference' {
            $store = script:New-CredentialStore

            $res = Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner inbound' -Type 'inbound' -SenderDomains 'partner.example.invalid' -SecretRef $global:connectorSecretRef -CredentialStore $store -DryRun $false -Confirmed $true

            $global:resolvedSecretRef | Should -Be $global:connectorSecretRef
            Assert-MockCalled New-InboundConnector -Times 1 -ParameterFilter { $TlsCertificate -eq $global:connectorSecretMaterial }
            $res.plan.after['secretRef'] | Should -Be $global:connectorSecretRef
            $res.auditEvent.after['secretRef'] | Should -Be $global:connectorSecretRef
            $json = $res | ConvertTo-Json -Depth 8
            $json | Should -Not -Match ([regex]::Escape($global:connectorSecretMaterial))
            $json | Should -Match ([regex]::Escape($global:connectorSecretRef))
        }

        It 'create preview with a secret reference plans without writing' {
            $store = script:New-CredentialStore

            $plan = Invoke-SetConnector -TenantId 'tenant-a' -Action 'create' -Name 'Partner inbound' -Type 'inbound' -SecretRef $global:connectorSecretRef -CredentialStore $store -DryRun $true

            $plan.dryRun | Should -BeTrue
            $plan.after['secretRef'] | Should -Be $global:connectorSecretRef
            $global:resolvedSecretRef | Should -Be $global:connectorSecretRef
            Assert-MockCalled New-InboundConnector -Times 0
        }
    }

    Context 'job envelope' {
        It 'parses the tenant, action, planned values, secret reference, and flags' {
            $jobPath = Join-Path $TestDrive 'connector-job.json'
            @{
                tenantId      = 'tenant-a'
                action        = 'disable'
                connectorId   = 'conn-in-1'
                enabled       = $false
                secretRef     = 'ref://tenants/tenant-a/connector-secret/abc-123'
                confirmed     = $true
                dryRun        = $false
                requireTls    = $true
                senderDomains = 'partner.example.invalid'
            } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-SetConnectorJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Action'] | Should -Be 'disable'
            $job['ConnectorId'] | Should -Be 'conn-in-1'
            $job['Enabled'] | Should -BeFalse
            $job['RequireTls'] | Should -BeTrue
            $job['SenderDomains'] | Should -Be 'partner.example.invalid'
            $job['SecretRef'] | Should -Be 'ref://tenants/tenant-a/connector-secret/abc-123'
            $job['Confirmed'] | Should -BeTrue
            $job['DryRun'] | Should -BeFalse
        }

        It 'leaves enabled and requireTls null when the envelope omits them' {
            $jobPath = Join-Path $TestDrive 'connector-job-minimal.json'
            @{ tenantId = 'tenant-a'; action = 'enable'; connectorId = 'conn-in-1' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-SetConnectorJob -Path $jobPath

            $job['Enabled'] | Should -BeNullOrEmpty
            $job['RequireTls'] | Should -BeNullOrEmpty
            $job['SecretRef'] | Should -Be ''
            $job['Confirmed'] | Should -BeFalse
            $job['DryRun'] | Should -BeFalse
        }

        It 'rejects envelopes without a tenant id or action and missing files' {
            $jobPath = Join-Path $TestDrive 'connector-job-empty.json'
            @{ tenantId = ''; action = 'disable' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8
            { Read-SetConnectorJob -Path $jobPath } | Should -Throw '*tenantId*'

            $jobPath = Join-Path $TestDrive 'connector-job-noaction.json'
            @{ tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8
            { Read-SetConnectorJob -Path $jobPath } | Should -Throw '*action*'

            { Read-SetConnectorJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
