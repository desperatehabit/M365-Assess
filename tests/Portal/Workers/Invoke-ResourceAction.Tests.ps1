BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-ResourceAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-resource-action.ps1'

    function global:Get-EXOMailbox {
        param($Identity, $ErrorAction)
    }
    function global:Get-DistributionGroup {
        param($Identity, $ErrorAction)
    }
    function global:Get-DistributionGroupMember {
        param($Identity, $ResultSize)
    }
    function global:New-Mailbox {
        param($Type, $Name, $DisplayName, $Capacity, $CustomAttribute1, $HiddenFromAddressListsEnabled, $ErrorAction)
    }
    function global:Set-EXOMailbox {
        param($Identity, $DisplayName, $Capacity, $CustomAttribute1, $HiddenFromAddressListsEnabled)
    }
    function global:Set-DistributionGroup {
        param($Identity, $DisplayName, $HiddenFromAddressListsEnabled)
    }
    function global:Remove-Mailbox {
        param($Identity, $Confirm)
    }
    function global:Remove-DistributionGroup {
        param($Identity, $Confirm)
    }
    function global:Add-DistributionGroupMember {
        param($Identity, $Member, $Confirm)
    }
    function global:Remove-DistributionGroupMember {
        param($Identity, $Member, $Confirm)
    }

    . $script:worker

    $script:roomMailbox = @{
        ExchangeObjectId              = 'room-1'
        DisplayName                   = 'Board Room'
        PrimarySmtpAddress            = 'board.room@example.invalid'
        RecipientTypeDetails          = 'RoomMailbox'
        Capacity                      = '12'
        CustomAttribute1              = 'Building A'
        HiddenFromAddressListsEnabled = $false
    }
    $script:equipmentMailbox = @{
        ExchangeObjectId              = 'equip-1'
        DisplayName                   = 'Projector Cart'
        PrimarySmtpAddress            = 'projector.cart@example.invalid'
        RecipientTypeDetails          = 'EquipmentMailbox'
        Capacity                      = $null
        CustomAttribute1              = ''
        HiddenFromAddressListsEnabled = $true
    }
    $script:roomList = @{
        ExchangeObjectId              = 'rl-1'
        DisplayName                   = 'Building A Rooms'
        PrimarySmtpAddress            = 'building.a.rooms@example.invalid'
        RecipientTypeDetails          = 'RoomList'
        HiddenFromAddressListsEnabled = $false
    }
    $script:roomListMembers = @(
        @{ ExchangeObjectId = 'room-1'; DisplayName = 'Board Room'; PrimarySmtpAddress = 'board.room@example.invalid' }
    )

    $script:resourceState = @{
        'room-1'  = @{ Record = $script:roomMailbox; Kind = 'Mailbox' }
        'equip-1' = @{ Record = $script:equipmentMailbox; Kind = 'Mailbox' }
        'rl-1'    = @{ Record = $script:roomList; Kind = 'DistributionGroup' }
    }

    function script:Update-ResourceState {
        param(
            [Parameter(Mandatory)]
            [string]$Identity,

            [object]$DisplayName,

            [object]$Capacity,

            [object]$Location,

            [object]$Hidden
        )

        $updated = $script:resourceState[$Identity].Record.PSObject.Copy()
        if ($null -ne $DisplayName) { $updated.DisplayName = [string]$DisplayName }
        if ($null -ne $Capacity) { $updated.Capacity = [string]$Capacity }
        if ($null -ne $Location) { $updated.CustomAttribute1 = [string]$Location }
        if ($null -ne $Hidden) { $updated.HiddenFromAddressListsEnabled = [bool]$Hidden }
        $script:resourceState[$Identity] = @{ Record = $updated; Kind = $script:resourceState[$Identity].Kind }
        return $updated
    }

    function script:New-ResourceMock {
        $script:resourceState = @{
            'room-1'  = @{ Record = $script:roomMailbox; Kind = 'Mailbox' }
            'equip-1' = @{ Record = $script:equipmentMailbox; Kind = 'Mailbox' }
            'rl-1'    = @{ Record = $script:roomList; Kind = 'DistributionGroup' }
        }
        $script:roomListMembers = @(
            @{ ExchangeObjectId = 'room-1'; DisplayName = 'Board Room'; PrimarySmtpAddress = 'board.room@example.invalid' }
        )
        Mock Get-EXOMailbox {
            param($Identity, $ErrorAction)
            if ($script:resourceState.ContainsKey($Identity) -and $script:resourceState[$Identity].Kind -eq 'Mailbox') {
                return $script:resourceState[$Identity].Record
            }
            throw 'Request_ResourceNotFound'
        }
        Mock Get-DistributionGroup {
            param($Identity, $ErrorAction)
            if ($script:resourceState.ContainsKey($Identity) -and $script:resourceState[$Identity].Kind -eq 'DistributionGroup') {
                return $script:resourceState[$Identity].Record
            }
            throw 'Request_ResourceNotFound'
        }
        Mock Get-DistributionGroupMember {
            param($Identity, $ResultSize)
            if ($Identity -eq 'rl-1') {
                return $script:roomListMembers
            }
            return @()
        }
        Mock New-Mailbox {
            param($Type, $Name, $DisplayName, $Capacity, $CustomAttribute1, $HiddenFromAddressListsEnabled, $ErrorAction)
            $script:newResource = @{
                ExchangeObjectId              = 'room-new'
                DisplayName                   = $DisplayName
                PrimarySmtpAddress            = ($DisplayName -replace '\s', '.').ToLowerInvariant() + '@example.invalid'
                RecipientTypeDetails          = $(if ($Type -eq 'Equipment') { 'EquipmentMailbox' } else { 'RoomMailbox' })
                Capacity                      = $Capacity
                CustomAttribute1              = $CustomAttribute1
                HiddenFromAddressListsEnabled = $HiddenFromAddressListsEnabled
            }
            return $script:newResource
        }
        Mock Set-EXOMailbox {
            param($Identity, $DisplayName, $Capacity, $CustomAttribute1, $HiddenFromAddressListsEnabled)
            return script:Update-ResourceState -Identity $Identity -DisplayName $DisplayName -Capacity $Capacity -Location $CustomAttribute1 -Hidden $HiddenFromAddressListsEnabled
        }
        Mock Set-DistributionGroup {
            param($Identity, $DisplayName, $HiddenFromAddressListsEnabled)
            return script:Update-ResourceState -Identity $Identity -DisplayName $DisplayName -Hidden $HiddenFromAddressListsEnabled
        }
        Mock Remove-Mailbox {
            param($Identity, $Confirm)
        }
        Mock Remove-DistributionGroup {
            param($Identity, $Confirm)
        }
        Mock Add-DistributionGroupMember {
            param($Identity, $Member, $Confirm)
            $script:roomListMembers += @{ ExchangeObjectId = $Member; DisplayName = 'New Member'; PrimarySmtpAddress = 'new.member@example.invalid' }
        }
        Mock Remove-DistributionGroupMember {
            param($Identity, $Member, $Confirm)
            $script:roomListMembers = @($script:roomListMembers | Where-Object { $_.ExchangeObjectId -ne $Member })
        }
    }
}

Describe 'Invoke-ResourceAction worker (T-0449)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-ResourceAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ResourceActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-ResourceActions -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the section-4.3 action set and the confirmation set' {
            Get-ResourceActions | Should -Be @('create', 'edit', 'delete', 'addMember', 'removeMember')
            Get-ResourceActionConfirmation | Should -Be @('delete')
        }

        It 'writes with the typed EXO cmdlets only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'New-Mailbox'
            $source | Should -Match 'Set-EXOMailbox'
            $source | Should -Match 'Set-DistributionGroup'
            $source | Should -Match 'Remove-Mailbox'
            $source | Should -Match 'Remove-DistributionGroup'
            $source | Should -Match 'Add-DistributionGroupMember'
            $source | Should -Match 'Remove-DistributionGroupMember'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'never persists resource data to disk, logs, or transcripts' {
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
            $entrySource | Should -Match 'Invoke-ResourceAction\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-ResourceActionJob -Path'
            $entrySource | Should -Match 'Invoke-ResourceAction'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'action dispatch' {
        BeforeEach {
            script:New-ResourceMock
        }

        It 'requires the tenant identifier' {
            { Invoke-ResourceAction -TenantId '' -Kind 'rooms' -Action 'create' -DisplayName 'Room' } | Should -Throw
        }

        It 'refuses an unknown action with a structured error and no EXO call' {
            { Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'wipeEverything' } | Should -Throw '*resources.unknown_action*'
            Should -Invoke New-Mailbox -Times 0 -Exactly
            Should -Invoke Remove-Mailbox -Times 0 -Exactly
        }

        It 'refuses an action that does not apply to the kind' {
            { Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'roomlists' -Action 'create' -DisplayName 'List' } | Should -Throw '*resources.kind_mismatch*'
            { Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'addMember' -ResourceId 'room-1' -MemberId 'room-2' } | Should -Throw '*resources.kind_mismatch*'
            Should -Invoke New-Mailbox -Times 0 -Exactly
            Should -Invoke Add-DistributionGroupMember -Times 0 -Exactly
        }

        It 'requires confirmation for delete with no EXO call' {
            { Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'delete' -ResourceId 'room-1' } | Should -Throw '*resources.confirm_required*'
            Should -Invoke Remove-Mailbox -Times 0 -Exactly
            Should -Invoke Remove-DistributionGroup -Times 0 -Exactly
        }

        It 'plans a create with no EXO write on dry run' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'create' -DisplayName 'Focus Room' -Capacity 8 -Location 'Building B' -DryRun:$true

            $result.action | Should -Be 'create'
            $result.dryRun | Should -BeTrue
            $result.before | Should -BeNullOrEmpty
            $result.after.name | Should -Be 'Focus Room'
            $result.after.capacity | Should -Be 8
            $result.after.location | Should -Be 'Building B'
            $result.after.type | Should -Be 'room'
            $result.requiresConfirmation | Should -BeFalse
            Should -Invoke New-Mailbox -Times 0 -Exactly
        }

        It 'plans a delete with no EXO write on dry run' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'delete' -ResourceId 'room-1' -Confirmed -DryRun:$true

            $result.action | Should -Be 'delete'
            $result.dryRun | Should -BeTrue
            $result.before.name | Should -Be 'Board Room'
            $result.requiresConfirmation | Should -BeTrue
            Should -Invoke Remove-Mailbox -Times 0 -Exactly
        }

        It 'creates a room with before/after capture and a success audit' {
            $script:audits = @()
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'create' -DisplayName 'Focus Room' -Capacity 8 -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.action | Should -Be 'create'
            $result.auditEvent.action | Should -Be 'resources.action:create'
            $result.auditEvent.result | Should -Be 'success'
            $result.auditEvent.resourceId | Should -Be 'room-new'
            Should -Invoke New-Mailbox -ParameterFilter { $Type -eq 'Room' -and $DisplayName -eq 'Focus Room' -and $Capacity -eq 8 }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
            $script:audits[0].after.id | Should -Be 'room-new'
        }

        It 'creates equipment through New-Mailbox -Type Equipment' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'equipment' -Action 'create' -DisplayName 'Projector Cart'

            $result.success | Should -BeTrue
            $result.plan.after.type | Should -Be 'equipment'
            Should -Invoke New-Mailbox -ParameterFilter { $Type -eq 'Equipment' -and $DisplayName -eq 'Projector Cart' }
        }

        It 'refuses a create without a display name' {
            { Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'create' } | Should -Throw '*displayName*'
            Should -Invoke New-Mailbox -Times 0 -Exactly
        }

        It 'edits a room with before/after capture and a success audit' {
            $script:audits = @()
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'edit' -ResourceId 'room-1' -DisplayName 'Renamed Room' -Capacity 20 -Location 'Building C' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.before.name | Should -Be 'Board Room'
            $result.plan.after.name | Should -Be 'Renamed Room'
            $result.plan.after.capacity | Should -Be 20
            $result.plan.after.location | Should -Be 'Building C'
            Should -Invoke Set-EXOMailbox -ParameterFilter { $Identity -eq 'room-1' -and $DisplayName -eq 'Renamed Room' -and $Capacity -eq 20 -and $CustomAttribute1 -eq 'Building C' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
        }

        It 'edits a room list through Set-DistributionGroup' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'roomlists' -Action 'edit' -ResourceId 'rl-1' -DisplayName 'Renamed List' -Hidden $true

            $result.success | Should -BeTrue
            Should -Invoke Set-DistributionGroup -ParameterFilter { $Identity -eq 'rl-1' -and $DisplayName -eq 'Renamed List' -and $HiddenFromAddressListsEnabled -eq $true }
            Should -Invoke Set-EXOMailbox -Times 0 -Exactly
        }

        It 'deletes a room with confirmation and a success audit' {
            $script:audits = @()
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'delete' -ResourceId 'room-1' -Confirmed -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.before.name | Should -Be 'Board Room'
            $result.auditEvent.action | Should -Be 'resources.action:delete'
            Should -Invoke Remove-Mailbox -ParameterFilter { $Identity -eq 'room-1' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
        }

        It 'deletes a room list through Remove-DistributionGroup' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'roomlists' -Action 'delete' -ResourceId 'rl-1' -Confirmed

            $result.success | Should -BeTrue
            Should -Invoke Remove-DistributionGroup -ParameterFilter { $Identity -eq 'rl-1' }
            Should -Invoke Remove-Mailbox -Times 0 -Exactly
        }

        It 'adds a member to a room list with a success audit' {
            $script:audits = @()
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'roomlists' -Action 'addMember' -ResourceId 'rl-1' -MemberId 'equip-1' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.diff[0] | Should -Match 'equip-1'
            Should -Invoke Add-DistributionGroupMember -ParameterFilter { $Identity -eq 'rl-1' -and $Member -eq 'equip-1' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].action | Should -Be 'resources.action:addMember'
            $script:audits[0].result | Should -Be 'success'
        }

        It 'rejects a duplicate membership with a failed result and no write' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'roomlists' -Action 'addMember' -ResourceId 'rl-1' -MemberId 'room-1'

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'already a member'
            Should -Invoke Add-DistributionGroupMember -Times 0 -Exactly
        }

        It 'removes a member from a room list with a success audit' {
            $script:audits = @()
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'roomlists' -Action 'removeMember' -ResourceId 'rl-1' -MemberId 'room-1' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.diff[0] | Should -Match 'room-1'
            Should -Invoke Remove-DistributionGroupMember -ParameterFilter { $Identity -eq 'rl-1' -and $Member -eq 'room-1' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].action | Should -Be 'resources.action:removeMember'
            $script:audits[0].result | Should -Be 'success'
        }

        It 'fails when removing a member that is not in the list' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'roomlists' -Action 'removeMember' -ResourceId 'rl-1' -MemberId 'equip-1'

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'not a member'
            Should -Invoke Remove-DistributionGroupMember -Times 0 -Exactly
        }

        It 'fails with a clear error when the resource does not exist' {
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'edit' -ResourceId 'room-9' -DisplayName 'New Name'

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'room-9'
            Should -Invoke Set-EXOMailbox -Times 0 -Exactly
        }

        It 'returns a per-action failure with a failure audit when EXO rejects the write' {
            Mock Set-EXOMailbox {
                param($Identity, $DisplayName, $Capacity, $CustomAttribute1, $HiddenFromAddressListsEnabled)
                throw 'Authorization_RequestDenied'
            }
            $script:audits = @()
            $result = Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'edit' -ResourceId 'room-1' -DisplayName 'New Name' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'Authorization_RequestDenied'
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'failure'
        }
    }

    Context 'job envelope' {
        It 'reads an action envelope with confirmation and dry-run flags' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("resource-action-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    correlationId = 'correlation-1'
                    payload       = @{ kind = 'rooms'; action = 'delete'; resourceId = 'room-1'; confirm = $true; dryRun = $false; actor = 'operator-1' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-ResourceActionJob -Path $path

                $job['TenantId'] | Should -Be 'tenant-a'
                $job['Kind'] | Should -Be 'rooms'
                $job['ResourceId'] | Should -Be 'room-1'
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

        It 'reads a create envelope with capacity and location' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("resource-action-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{ kind = 'rooms'; action = 'create'; displayName = 'Focus Room'; capacity = 8; location = 'Building B' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-ResourceActionJob -Path $path

                $job['Action'] | Should -Be 'create'
                $job['DisplayName'] | Should -Be 'Focus Room'
                $job['Capacity'] | Should -Be 8
                $job['Location'] | Should -Be 'Building B'
                $job['ResourceId'] | Should -Be ''
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads a membership envelope' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("resource-action-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{ kind = 'roomlists'; action = 'addMember'; resourceId = 'rl-1'; memberId = 'room-1' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-ResourceActionJob -Path $path

                $job['Action'] | Should -Be 'addMember'
                $job['MemberId'] | Should -Be 'room-1'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects a missing file, a bad schema version, and missing fields' {
            { Read-ResourceActionJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'no-such-job.json') } | Should -Throw

            $badVersion = Join-Path ([System.IO.Path]::GetTempPath()) ("resource-action-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a'; payload = @{ action = 'delete' } } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            try {
                { Read-ResourceActionJob -Path $badVersion } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $badVersion -Force -ErrorAction SilentlyContinue
            }

            $noAction = Join-Path ([System.IO.Path]::GetTempPath()) ("resource-action-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ kind = 'rooms' } } | ConvertTo-Json | Set-Content -LiteralPath $noAction -Encoding UTF8
            try {
                { Read-ResourceActionJob -Path $noAction } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noAction -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
