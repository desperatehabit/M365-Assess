BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/New-Team.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/new-team.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    function script:New-TeamPlan {
        param(
            [string]$Name = 'Project Alpha',
            [string[]]$Owners = @('owner@example.invalid'),
            [string[]]$Members = @('member@example.invalid'),
            [string]$Visibility = 'public'
        )
        return [pscustomobject]@{
            name       = $Name
            owners     = $Owners
            members    = $Members
            visibility = $Visibility
        }
    }

    function script:New-TeamTemplate {
        return [pscustomobject]@{
            id         = 'tpl-standard'
            name       = 'Standard Team'
            owners     = @('owner-template@example.invalid')
            members    = @('member-template@example.invalid')
            visibility = 'private'
            settings   = @{ allowGuests = $false; channels = @('general', 'ops') }
        }
    }
}

Describe 'New-Team worker (T-0504)' {

    Context 'the worker files' {
        It 'ships the handler and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command New-Team -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Resolve-TeamTemplate -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-TeamCreateInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command New-TeamOperation -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-TeamCreateJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'creates with POST only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method POST'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint delegates to the handler and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'New-Team\.ps1'
            $entrySource | Should -Match 'Read-TeamCreateJob -Path'
            $entrySource | Should -Match 'New-Team -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'template expansion' {
        It 'uses the wizard values when no template is supplied' {
            $resolved = Resolve-TeamTemplate -Team (script:New-TeamPlan)
            $resolved.name | Should -Be 'Project Alpha'
            $resolved.owners | Should -Contain 'owner@example.invalid'
            $resolved.members | Should -Contain 'member@example.invalid'
            $resolved.visibility | Should -Be 'public'
            $resolved.templateId | Should -BeNullOrEmpty
            $resolved.settings.Count | Should -Be 0
        }

        It 'expands a supplied template owners, members, and settings' {
            $resolved = Resolve-TeamTemplate -Team (script:New-TeamPlan -Visibility '') -Template (script:New-TeamTemplate)
            $resolved.owners | Should -Contain 'owner@example.invalid'
            $resolved.owners | Should -Contain 'owner-template@example.invalid'
            $resolved.members | Should -Contain 'member@example.invalid'
            $resolved.members | Should -Contain 'member-template@example.invalid'
            $resolved.visibility | Should -Be 'private'
            $resolved.templateId | Should -Be 'tpl-standard'
            $resolved.settings['allowGuests'] | Should -BeFalse
            $resolved.settings['channels'] | Should -Contain 'ops'
        }

        It 'keeps the explicit visibility and de-duplicates shared identities' {
            $plan = script:New-TeamPlan -Visibility 'public' -Owners @('owner@example.invalid', 'owner-template@example.invalid')
            $resolved = Resolve-TeamTemplate -Team $plan -Template (script:New-TeamTemplate)
            $resolved.visibility | Should -Be 'public'
            @($resolved.owners | Where-Object { $_ -eq 'owner-template@example.invalid' }).Count | Should -Be 1
        }
    }

    Context 'input validation' {
        It 'requires a name' {
            $errors = @(Test-TeamCreateInput -Team ([pscustomobject]@{ name = '  '; visibility = 'private' }))
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'name is required'
        }

        It 'rejects an unknown visibility' {
            $errors = @(Test-TeamCreateInput -Team ([pscustomobject]@{ name = 'Team'; visibility = 'secret' }))
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'public or private'
        }
    }

    Context 'create' {
        It 'plans without writing on DryRun' {
            Mock Invoke-MgGraphRequest { }
            $result = New-Team -TenantId 'tenant-a' -Team (script:New-TeamPlan) -DryRun

            $result.status | Should -Be 'planned'
            $result.plan.after.name | Should -Be 'Project Alpha'
            $result.plan.after.owners | Should -Contain 'owner@example.invalid'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'creates the team live and audits with a TeamOperation' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ id = 'team-1' }
            }
            $events = [System.Collections.Generic.List[object]]::new()
            $operations = [System.Collections.Generic.List[object]]::new()
            $result = New-Team -TenantId 'tenant-a' -Team (script:New-TeamPlan) -Actor 'user-1' `
                -WriteAudit { param($e) $events.Add($e) } `
                -WriteTeamOperation { param($o) $operations.Add($o) }

            $result.status | Should -Be 'created'
            $result.id | Should -Be 'team-1'
            $result.auditEvent.after.id | Should -Be 'team-1'

            $events.Count | Should -Be 1
            $events[0].action | Should -Be 'teams.team.create'
            $events[0].tenantId | Should -Be 'tenant-a'
            $events[0].targetId | Should -Be 'team-1'
            $events[0].after.owners | Should -Contain 'owner@example.invalid'

            $operations.Count | Should -Be 1
            $operations[0].operation | Should -Be 'create'
            $operations[0].state | Should -Be 'applied'
            $operations[0].teamId | Should -Be 'team-1'
            $operations[0].by | Should -Be 'user-1'

            Should -Invoke Invoke-MgGraphRequest -Times 1 -ParameterFilter { $Method -eq 'POST' -and $Uri -eq '/v1.0/teams' }
        }

        It 'expands a template into the create body' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ id = 'team-2' }
            }
            $result = New-Team -TenantId 'tenant-a' -Team (script:New-TeamPlan -Visibility '') -Template (script:New-TeamTemplate)

            $result.status | Should -Be 'created'
            $result.plan.after.templateId | Should -Be 'tpl-standard'
            $result.plan.after.owners | Should -Contain 'owner-template@example.invalid'
            $result.plan.after.members | Should -Contain 'member-template@example.invalid'
            $result.plan.after.settings['allowGuests'] | Should -BeFalse
            Should -Invoke Invoke-MgGraphRequest -Times 1 -ParameterFilter {
                $Method -eq 'POST' -and $Uri -eq '/v1.0/teams' -and $Body -match 'owner-template@example.invalid'
            }
        }

        It 'reports a create failure without throwing' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                throw 'graph denied'
            }
            $operations = [System.Collections.Generic.List[object]]::new()
            $result = New-Team -TenantId 'tenant-a' -Team (script:New-TeamPlan) `
                -WriteTeamOperation { param($o) $operations.Add($o) }

            $result.status | Should -Be 'failed'
            $result.success | Should -BeFalse
            $result.error | Should -Match 'graph denied'
            $operations.Count | Should -Be 1
            $operations[0].state | Should -Be 'failed'
        }
    }

    Context 'job envelope' {
        It 'reads the team, template, dry-run flag, and actor' {
            $jobFile = Join-Path $TestDrive 'team-create-job.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                correlationId = 'corr-1'
                payload       = @{
                    team     = @{ name = 'Project Alpha'; owners = @('owner@example.invalid'); members = @(); visibility = 'public' }
                    template = @{ id = 'tpl-standard'; owners = @('owner-template@example.invalid'); members = @(); visibility = 'private'; settings = @{} }
                    dryRun   = $true
                    actor    = 'user-1'
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jobFile

            $job = Read-TeamCreateJob -Path $jobFile
            $job.TenantId | Should -Be 'tenant-a'
            $job.Team.name | Should -Be 'Project Alpha'
            $job.Template.id | Should -Be 'tpl-standard'
            $job.DryRun | Should -BeTrue
            $job.Actor | Should -Be 'user-1'
            $job.CorrelationId | Should -Be 'corr-1'
        }
    }
}
