BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-TeamAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-team-action.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    function script:New-ActionMock {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            if ($Uri -like '/v1.0/teams/team-live*') {
                return @{
                    id          = 'team-live'
                    displayName = 'Project Alpha'
                    description = 'Alpha team'
                    visibility  = 'public'
                    isArchived  = $false
                }
            }
            return $null
        }
    }
}

Describe 'Invoke-TeamAction worker (T-0505)' {

    Context 'the worker files' {
        It 'ships the handler and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-TeamAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-TeamEdit -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-TeamArchive -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-TeamClone -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-TeamDelete -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-TeamActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'writes with GET/POST/PATCH/DELETE only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method PATCH'
            $source | Should -Match 'Invoke-MgGraphRequest -Method POST'
            $source | Should -Match 'Invoke-MgGraphRequest -Method DELETE'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint delegates to the dispatcher and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-TeamAction\.ps1'
            $entrySource | Should -Match 'Read-TeamActionJob -Path'
            $entrySource | Should -Match 'Invoke-TeamAction -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'team edit' {
        BeforeEach {
            New-ActionMock
        }

        It 'plans without writing on DryRun' {
            $plan = Invoke-TeamEdit -TenantId 'tenant-test' -TeamId 'team-live' -Changes @{ description = 'Updated' } -DryRun $true
            $plan.action | Should -Be 'edit'
            $plan.dryRun | Should -BeTrue
            $plan.before.displayName | Should -Be 'Project Alpha'
            $plan.after.description | Should -Be 'Updated'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'applies with a PATCH and records before/after, an audit event, and a TeamOperation' {
            $events = [System.Collections.Generic.List[object]]::new()
            $operations = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-TeamEdit -TenantId 'tenant-test' -TeamId 'team-live' -Changes @{ description = 'Updated' } `
                -Actor 'operator-1' -WriteAudit { param($e) $events.Add($e) } `
                -WriteTeamOperation { param($o) $operations.Add($o) }

            $result.success | Should -BeTrue
            $result.state | Should -Be 'succeeded'
            $result.operation | Should -Be 'edit'
            $result.auditEvent.action | Should -Be 'teams.team.edit'
            $result.auditEvent.before.description | Should -Be 'Alpha team'
            $result.auditEvent.after.description | Should -Be 'Updated'
            $operations.Count | Should -Be 1
            $operations[0].operation | Should -Be 'edit'
            $operations[0].state | Should -Be 'applied'
            $operations[0].teamId | Should -Be 'team-live'
            $operations[0].by | Should -Be 'operator-1'
            $events.Count | Should -Be 1
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' -and $Uri -eq '/v1.0/teams/team-live' }
        }

        It 'refuses an unknown team without writing' {
            {
                Invoke-TeamEdit -TenantId 'tenant-test' -TeamId 'team-missing' -Changes @{ description = 'x' }
            } | Should -Throw '*NotFound*live team*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }
    }

    Context 'team archive' {
        BeforeEach {
            New-ActionMock
        }

        It 'plans without writing on DryRun' {
            $plan = Invoke-TeamArchive -TenantId 'tenant-test' -TeamId 'team-live' -DryRun $true
            $plan.action | Should -Be 'archive'
            $plan.dryRun | Should -BeTrue
            $plan.before.isArchived | Should -BeFalse
            $plan.after.isArchived | Should -BeTrue
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        }

        It 'applies an archive without confirmation and records an audit event and a TeamOperation' {
            $events = [System.Collections.Generic.List[object]]::new()
            $operations = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-TeamArchive -TenantId 'tenant-test' -TeamId 'team-live' `
                -WriteAudit { param($e) $events.Add($e) } `
                -WriteTeamOperation { param($o) $operations.Add($o) }

            $result.success | Should -BeTrue
            $result.operation | Should -Be 'archive'
            $result.result.state | Should -Be 'archived'
            $result.auditEvent.action | Should -Be 'teams.team.archive'
            $result.auditEvent.after.isArchived | Should -BeTrue
            $operations[0].operation | Should -Be 'archive'
            $operations[0].state | Should -Be 'applied'
            $events.Count | Should -Be 1
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -eq '/v1.0/teams/team-live/archive' }
        }

        It 'refuses an unknown team without writing' {
            {
                Invoke-TeamArchive -TenantId 'tenant-test' -TeamId 'team-missing'
            } | Should -Throw '*NotFound*live team*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        }
    }

    Context 'team clone' {
        BeforeEach {
            New-ActionMock
        }

        It 'plans without writing on DryRun' {
            $plan = Invoke-TeamClone -TenantId 'tenant-test' -TeamId 'team-live' -NewName 'Project Alpha (copy)' -DryRun $true
            $plan.action | Should -Be 'clone'
            $plan.targetName | Should -Be 'Project Alpha (copy)'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        }

        It 'applies a clone and records an audit event and a TeamOperation' {
            $events = [System.Collections.Generic.List[object]]::new()
            $operations = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-TeamClone -TenantId 'tenant-test' -TeamId 'team-live' -NewName 'Project Alpha (copy)' `
                -WriteAudit { param($e) $events.Add($e) } `
                -WriteTeamOperation { param($o) $operations.Add($o) }

            $result.success | Should -BeTrue
            $result.operation | Should -Be 'clone'
            $result.result.state | Should -Be 'cloning'
            $result.auditEvent.action | Should -Be 'teams.team.clone'
            $operations[0].operation | Should -Be 'clone'
            $events.Count | Should -Be 1
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'POST' -and $Uri -eq '/v1.0/teams/team-live/clone' -and $Body -match 'Project Alpha \(copy\)'
            }
        }

        It 'requires a new name' {
            {
                Invoke-TeamClone -TenantId 'tenant-test' -TeamId 'team-live'
            } | Should -Throw '*newName is required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        }
    }

    Context 'team delete confirmation' {
        BeforeEach {
            New-ActionMock
        }

        It 'plans without writing on DryRun and requires confirmation' {
            $plan = Invoke-TeamDelete -TenantId 'tenant-test' -TeamId 'team-live' -DryRun $true
            $plan.action | Should -Be 'delete'
            $plan.requiresConfirmation | Should -BeTrue
            $plan.targetName | Should -Be 'Project Alpha'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'refuses an apply without confirmation and writes nothing' {
            {
                Invoke-TeamDelete -TenantId 'tenant-test' -TeamId 'team-live'
            } | Should -Throw '*confirm_required*'
            {
                Invoke-TeamDelete -TenantId 'tenant-test' -TeamId 'team-live' -Confirmed $true
            } | Should -Throw '*confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'refuses a confirmation that does not name the team and writes nothing' {
            {
                Invoke-TeamDelete -TenantId 'tenant-test' -TeamId 'team-live' -Confirmed $true -ConfirmName 'Wrong Name'
            } | Should -Throw '*confirm_name_mismatch*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'applies a delete naming the team and records before/after, an audit event, and a TeamOperation' {
            $events = [System.Collections.Generic.List[object]]::new()
            $operations = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-TeamDelete -TenantId 'tenant-test' -TeamId 'team-live' -Confirmed $true -ConfirmName 'Project Alpha' `
                -Actor 'operator-1' -WriteAudit { param($e) $events.Add($e) } `
                -WriteTeamOperation { param($o) $operations.Add($o) }

            $result.success | Should -BeTrue
            $result.state | Should -Be 'succeeded'
            $result.operation | Should -Be 'delete'
            $result.auditEvent.action | Should -Be 'teams.team.delete'
            $result.auditEvent.before.displayName | Should -Be 'Project Alpha'
            $result.auditEvent.after.state | Should -Be 'deleted'
            $operations[0].operation | Should -Be 'delete'
            $operations[0].state | Should -Be 'applied'
            $events.Count | Should -Be 1
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Uri -eq '/v1.0/teams/team-live' }
        }

        It 'refuses an unknown team without writing' {
            {
                Invoke-TeamDelete -TenantId 'tenant-test' -TeamId 'team-missing' -Confirmed $true -ConfirmName 'Project Alpha'
            } | Should -Throw '*NotFound*live team*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }
    }

    Context 'dispatcher' {
        BeforeEach {
            New-ActionMock
        }

        It 'routes an archive action to the archive handler' {
            $result = Invoke-TeamAction -TenantId 'tenant-test' -Action 'archive' -TeamId 'team-live'
            $result.operation | Should -Be 'archive'
        }

        It 'rejects an unknown action' {
            {
                Invoke-TeamAction -TenantId 'tenant-test' -Action 'explode' -TeamId 'team-live'
            } | Should -Throw
        }
    }

    Context 'job envelope' {
        It 'reads tenant, action, target, clone values, confirmation, and flags' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('team-action-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-test'
                    action        = 'clone'
                    actor         = 'operator-1'
                    correlationId = 'corr-1'
                    payload       = @{
                        teamId       = 'team-live'
                        newName      = 'Project Alpha (copy)'
                        visibility   = 'private'
                        confirm      = $true
                        confirmName  = 'Project Alpha'
                        dryRun       = $false
                    }
                } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-TeamActionJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['Action'] | Should -Be 'clone'
                $job['TeamId'] | Should -Be 'team-live'
                $job['NewName'] | Should -Be 'Project Alpha (copy)'
                $job['Confirmed'] | Should -BeTrue
                $job['ConfirmName'] | Should -Be 'Project Alpha'
                $job['Actor'] | Should -Be 'operator-1'
                $job['CorrelationId'] | Should -Be 'corr-1'
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads edit changes from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('team-action-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-test'
                    action        = 'edit'
                    payload       = @{
                        teamId  = 'team-live'
                        changes = @{ description = 'Updated' }
                    }
                } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-TeamActionJob -Path $jobPath
                $job['Action'] | Should -Be 'edit'
                $job['Changes']['description'] | Should -Be 'Updated'
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-TeamActionJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'team-action-does-not-exist.json')
            } | Should -Throw '*job file not found*'
        }

        It 'rejects an unsupported action' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('team-action-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-test'
                    action        = 'explode'
                    payload       = @{}
                } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                { Read-TeamActionJob -Path $jobPath } | Should -Throw '*unsupported action*'
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
