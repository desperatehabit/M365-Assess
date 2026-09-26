BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:workerScript = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Write-RunProgress.ps1'
    $script:workerModule = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/M365Portal.Workers.psm1'

    Import-Module -Name $script:workerModule -Force

    $script:stubTenantId = '11111111-1111-1111-1111-111111111111'
    $script:stubRunId = 'run-1234-abcd'
    $script:stubJobId = 'job-5678-ef01'
}

AfterAll {
    Remove-Module -Name 'M365Portal.Workers' -ErrorAction SilentlyContinue
}

Describe 'Write-RunProgress worker cmdlet and progress bridge (T-0045)' {

    Context 'Module exports and layout' {
        It 'ships the Write-RunProgress script alongside the worker module' {
            Test-Path -LiteralPath $script:workerScript | Should -BeTrue
            Test-Path -LiteralPath $script:workerModule | Should -BeTrue
        }

        It 'exports Write-RunProgress and progress bridge functions from the module' {
            $exported = (Get-Module -Name 'M365Portal.Workers').ExportedFunctions.Keys
            $exported | Should -Contain 'Write-RunProgress'
            $exported | Should -Contain 'Register-RunProgressBridge'
            $exported | Should -Contain 'Complete-RunProgressBridge'
            $exported | Should -Contain 'Step-RunSectionProgress'
            $exported | Should -Contain 'Get-RunProgressSection'
        }
    }

    Context 'Direct event emission and T-0014 contract shape' {
        BeforeEach {
            Reset-RunProgressSequence
        }

        It 'emits valid T-0014 progress event JSON with monotonic sequence' {
            $lines = [System.Collections.Generic.List[string]]::new()
            $channel = { param($json) $lines.Add($json) }

            $event1 = Write-RunProgress -RunId $script:stubRunId -TenantId $script:stubTenantId -JobId $script:stubJobId `
                -State 'running' -Section 'Identity' -SectionState 'running' `
                -Completed 0 -Total 20 -Channel $channel -PassThru

            $event2 = Write-RunProgress -RunId $script:stubRunId -TenantId $script:stubTenantId -JobId $script:stubJobId `
                -State 'running' -Section 'Identity' -SectionState 'succeeded' `
                -Completed 10 -Total 20 -Channel $channel -PassThru

            $lines.Count | Should -Be 2

            # Assert shape of event 1
            $event1.schemaVersion | Should -Be 'v1'
            $event1.sequence | Should -Be 0
            $event1.eventId | Should -Not -BeNullOrEmpty
            $event1.runId | Should -Be $script:stubRunId
            $event1.tenantId | Should -Be $script:stubTenantId
            $event1.jobId | Should -Be $script:stubJobId
            $event1.jobType | Should -Be 'assessment'
            $event1.state | Should -Be 'running'
            $event1.section | Should -Be 'Identity'
            $event1.sectionState | Should -Be 'running'
            $event1.completed | Should -Be 0
            $event1.total | Should -Be 20

            # Assert shape of event 2
            $event2.sequence | Should -Be 1
            $event2.sectionState | Should -Be 'succeeded'
            $event2.completed | Should -Be 10

            # Verify both lines parse as valid JSON
            $jsonObj1 = $lines[0] | ConvertFrom-Json
            $jsonObj1.schemaVersion | Should -Be 'v1'
            $jsonObj1.sequence | Should -Be 0

            $jsonObj2 = $lines[1] | ConvertFrom-Json
            $jsonObj2.sequence | Should -Be 1
            $jsonObj2.section | Should -Be 'Identity'
        }

        It 'suppresses check-level events when opt-in flag is not set' {
            $lines = [System.Collections.Generic.List[string]]::new()
            $channel = { param($json) $lines.Add($json) }

            $result = Write-RunProgress -RunId $script:stubRunId -TenantId $script:stubTenantId -JobId $script:stubJobId `
                -CheckId 'ENTRA-ADMIN-001' -Setting 'Admin Role' -CheckStatus 'Pass' `
                -Channel $channel -PassThru

            $result | Should -BeNullOrEmpty
            $lines.Count | Should -Be 0
        }

        It 'emits check-level events when opt-in flag is set' {
            $lines = [System.Collections.Generic.List[string]]::new()
            $channel = { param($json) $lines.Add($json) }

            $event = Write-RunProgress -RunId $script:stubRunId -TenantId $script:stubTenantId -JobId $script:stubJobId `
                -CheckId 'ENTRA-ADMIN-001' -Setting 'Admin Role' -CheckStatus 'Pass' `
                -Completed 1 -Total 10 -EmitCheckDetail -Channel $channel -PassThru

            $event | Should -Not -BeNullOrEmpty
            $lines.Count | Should -Be 1
            $event.section | Should -Be 'Identity'
            $event.message | Should -Match 'ENTRA-ADMIN-001'
            $event.message | Should -Match 'Pass'
            $event.completed | Should -Be 1
        }
    }

    Context 'Mapping module progress via bridge' {
        AfterEach {
            Complete-RunProgressBridge -Status 'succeeded'
        }

        It 'emits RunSection events per section and advances check counter by default' {
            $emittedJson = [System.Collections.Generic.List[string]]::new()
            $channel = { param($json) $emittedJson.Add($json) }

            Register-RunProgressBridge -RunId $script:stubRunId -TenantId $script:stubTenantId -JobId $script:stubJobId `
                -TotalChecks 10 -Channel $channel

            # Simulate module calling Update-CheckProgress across sections
            Update-CheckProgress -CheckId 'ENTRA-ADMIN-001' -Setting 'Admins' -Status 'Pass'
            Update-CheckProgress -CheckId 'ENTRA-SECDEFAULT-001' -Setting 'SecDefaults' -Status 'Pass'
            Update-CheckProgress -CheckId 'EXO-TRANSPORT-001' -Setting 'Transport' -Status 'Pass'
            Update-CheckProgress -CheckId 'DEFENDER-AV-001' -Setting 'Antivirus' -Status 'Pass'

            Complete-RunProgressBridge -Status 'succeeded'

            $events = @($emittedJson | ForEach-Object { $_ | ConvertFrom-Json })
            $events.Count | Should -BeGreaterThan 0

            # Every event should be a RunSection event (no check-level events by default)
            foreach ($e in $events) {
                $e.schemaVersion | Should -Be 'v1'
                $e.runId | Should -Be $script:stubRunId
                $e.tenantId | Should -Be $script:stubTenantId
                $e.section | Should -Not -BeNullOrEmpty
                $e.sectionState | Should -Not -BeNullOrEmpty
            }

            # The check counter advances across events
            $counters = @($events | ForEach-Object { [int]$_.completed })
            $counters | Should -Contain 1
            $counters | Should -Contain 4
            # Assert monotonic sequences
            for ($i = 0; $i -lt $events.Count; $i++) {
                $events[$i].sequence | Should -Be $i
            }

            # Assert sections were visited
            $sections = @($events | ForEach-Object { $_.section })
            $sections | Should -Contain 'Identity'
            $sections | Should -Contain 'Email'
            $sections | Should -Contain 'Security'
        }

        It 'emits check-level events when opt-in flag EmitCheckDetail is set' {
            $emittedJson = [System.Collections.Generic.List[string]]::new()
            $channel = { param($json) $emittedJson.Add($json) }

            Register-RunProgressBridge -RunId $script:stubRunId -TenantId $script:stubTenantId -JobId $script:stubJobId `
                -TotalChecks 5 -EmitCheckDetail -Channel $channel

            Update-CheckProgress -CheckId 'ENTRA-ADMIN-001' -Setting 'Admin Role' -Status 'Pass'
            Update-CheckProgress -CheckId 'ENTRA-SECDEFAULT-001' -Setting 'Defaults' -Status 'Fail'

            Complete-RunProgressBridge -Status 'succeeded'

            $events = @($emittedJson | ForEach-Object { $_ | ConvertFrom-Json })

            # Check-level events must be present in messages
            $messages = @($events | ForEach-Object { $_.message } | Where-Object { $_ })
            $messages.Count | Should -BeGreaterOrEqual 2
            ($messages -match 'ENTRA-ADMIN-001').Count | Should -BeGreaterOrEqual 1
            ($messages -match 'ENTRA-SECDEFAULT-001').Count | Should -BeGreaterOrEqual 1
        }
    }

    Context 'Step-RunSectionProgress' {
        It 'explicitly steps section progress' {
            $emitted = [System.Collections.Generic.List[string]]::new()
            $channel = { param($json) $emitted.Add($json) }

            $evt = Step-RunSectionProgress -RunId $script:stubRunId -TenantId $script:stubTenantId -JobId $script:stubJobId `
                -Section 'Intune' -SectionState 'running' -Completed 5 -Total 20 `
                -Channel $channel -PassThru

            $evt.section | Should -Be 'Intune'
            $evt.sectionState | Should -Be 'running'
            $evt.completed | Should -Be 5
            $evt.total | Should -Be 20
            $emitted.Count | Should -Be 1
        }
    }
}
