# Invoke-ScheduledReport.Tests.ps1
# Pester tests for T-0090 — scheduled report generation and delivery hand-off.
# Asserts: happy path produces one GeneratedReport and delivery request,
# idempotency prevents duplicates on retry, a failed render marks the job
# failed without a partial row, and delivery is through the EPIC-029 channel
# (not bespoke email).

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Invoke-ScheduledReport' {
    BeforeAll {
        . (Join-Path $PSScriptRoot '../../../portal/workers/M365Portal.Workers/Invoke-ScheduledReport.ps1')

    #region ── Stub factories ───────────────────────────────────────────────────

    function New-Schedule {
        param(
            [string]$TemplateId = 'tmpl-1',
            [string]$TenantId   = 't1'
        )
        return [PSCustomObject]@{
            TemplateId     = $TemplateId
            TenantId       = $TenantId
            BrandingConfig = $null
        }
    }

    function New-ScheduleRepo {
        param([PSCustomObject]$Schedule = (New-Schedule))
        $repo = [PSCustomObject]@{ Schedule = $Schedule }
        Add-Member -InputObject $repo -MemberType ScriptMethod -Name 'GetSchedule' -Value {
            param($id) return $this.Schedule
        } -Force
        return $repo
    }

    $script:CreatedRows  = [System.Collections.Generic.List[PSCustomObject]]::new()
    $script:MarkedFailed = [System.Collections.Generic.List[string]]::new()
    $script:MarkedSucceeded = [System.Collections.Generic.List[PSCustomObject]]::new()

    function New-ReportRepo {
        param([PSCustomObject]$ExistingRow = $null)
        # ScriptMethod bodies execute bound to the object, so all state is
        # reached through $this; they do not close over local variables.
        $repo = [PSCustomObject]@{
            Existing        = $ExistingRow
            Created         = $script:CreatedRows
            MarkedFailed    = $script:MarkedFailed
            MarkedSucceeded = $script:MarkedSucceeded
        }

        Add-Member -InputObject $repo -MemberType ScriptMethod -Name 'FindByScheduleRunAt' -Value {
            param($sid, $ra) return $this.Existing
        }
        Add-Member -InputObject $repo -MemberType ScriptMethod -Name 'Create' -Value {
            param($row) $this.Created.Add($row); return $row
        }
        Add-Member -InputObject $repo -MemberType ScriptMethod -Name 'MarkSucceeded' -Value {
            param($id, $ref) $this.MarkedSucceeded.Add([PSCustomObject]@{ Id = $id; ArtifactRef = $ref })
        }
        Add-Member -InputObject $repo -MemberType ScriptMethod -Name 'MarkFailed' -Value {
            param($id) $this.MarkedFailed.Add($id)
        }
        return $repo
    }

    $script:DeliveryRequests = [System.Collections.Generic.List[PSCustomObject]]::new()

    function New-DeliveryChannel {
        $chan = [PSCustomObject]@{ Requests = $script:DeliveryRequests }
        Add-Member -InputObject $chan -MemberType ScriptMethod -Name 'SendDeliveryRequest' -Value {
            param($sid, $rid, $tid) $this.Requests.Add([PSCustomObject]@{ ScheduleId = $sid; ReportId = $rid; TenantId = $tid })
        }
        return $chan
    }

    function New-RenderPort {
        param([bool]$ShouldFail = $false)
        $port = [PSCustomObject]@{ ShouldFail = $ShouldFail }
        Add-Member -InputObject $port -MemberType ScriptMethod -Name 'RenderTemplate' -Value {
            param($templateId, $tenantId, $brandingConfig)
            if ($this.ShouldFail) {
                throw [System.InvalidOperationException]::new('render.failed: test-induced failure')
            }
            return [PSCustomObject]@{ ArtifactRef = '/art/report.pdf' }
        }
        return $port
    }

    }

    BeforeEach {
        $script:CreatedRows.Clear()
        $script:MarkedFailed.Clear()
        $script:MarkedSucceeded.Clear()
        $script:DeliveryRequests.Clear()
    }

    #endregion

    Context 'Happy path' {
        It 'Produces exactly one GeneratedReport row and one delivery request' {
            $payload = [PSCustomObject]@{ ScheduleId = 's1'; RunAt = '2026-01-01T06:00:00Z' }
            $result  = Invoke-ScheduledReport `
                -JobPayload      $payload `
                -ScheduleRepo    (New-ScheduleRepo) `
                -ReportRepo      (New-ReportRepo) `
                -RenderPort      (New-RenderPort) `
                -DeliveryChannel (New-DeliveryChannel)

            $result.Status       | Should -Be 'succeeded'
            $result.WasDuplicate | Should -BeFalse

            $script:CreatedRows.Count     | Should -Be 1
            $script:MarkedSucceeded.Count | Should -Be 1
            $script:DeliveryRequests.Count | Should -Be 1
        }

        It 'Stores the artifact reference on success' {
            $payload = [PSCustomObject]@{ ScheduleId = 's1'; RunAt = '2026-01-01T06:00:00Z' }
            Invoke-ScheduledReport `
                -JobPayload      $payload `
                -ScheduleRepo    (New-ScheduleRepo) `
                -ReportRepo      (New-ReportRepo) `
                -RenderPort      (New-RenderPort) `
                -DeliveryChannel (New-DeliveryChannel) | Out-Null

            $script:MarkedSucceeded[0].ArtifactRef | Should -Be '/art/report.pdf'
        }

        It 'Delivery is sent through the EPIC-029 channel seam (not direct email)' {
            $payload = [PSCustomObject]@{ ScheduleId = 's1'; RunAt = '2026-01-01T06:00:00Z' }
            Invoke-ScheduledReport `
                -JobPayload      $payload `
                -ScheduleRepo    (New-ScheduleRepo) `
                -ReportRepo      (New-ReportRepo) `
                -RenderPort      (New-RenderPort) `
                -DeliveryChannel (New-DeliveryChannel) | Out-Null

            $req = $script:DeliveryRequests[0]
            $req.ScheduleId | Should -Be 's1'
            $req.TenantId   | Should -Be 't1'
            $req.ReportId   | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Idempotency — retried job does not duplicate the row' {
        It 'Returns WasDuplicate=true and does not create a new row' {
            $existingRow = [PSCustomObject]@{ Id = 'rpt-existing'; Status = 'succeeded' }
            $payload = [PSCustomObject]@{ ScheduleId = 's1'; RunAt = '2026-01-01T06:00:00Z' }
            $result  = Invoke-ScheduledReport `
                -JobPayload      $payload `
                -ScheduleRepo    (New-ScheduleRepo) `
                -ReportRepo      (New-ReportRepo -ExistingRow $existingRow) `
                -RenderPort      (New-RenderPort) `
                -DeliveryChannel (New-DeliveryChannel)

            $result.WasDuplicate      | Should -BeTrue
            $result.GeneratedReportId | Should -Be 'rpt-existing'
            $script:CreatedRows.Count  | Should -Be 0
        }
    }

    Context 'Failed render' {
        It 'Marks the row failed without a partial/running row remaining' {
            $payload = [PSCustomObject]@{ ScheduleId = 's1'; RunAt = '2026-01-01T06:00:00Z' }
            { Invoke-ScheduledReport `
                -JobPayload      $payload `
                -ScheduleRepo    (New-ScheduleRepo) `
                -ReportRepo      (New-ReportRepo) `
                -RenderPort      (New-RenderPort -ShouldFail $true) `
                -DeliveryChannel (New-DeliveryChannel) } | Should -Throw

            $script:MarkedFailed.Count    | Should -Be 1
            $script:MarkedSucceeded.Count | Should -Be 0
            $script:DeliveryRequests.Count | Should -Be 0
        }

        It 'Does not emit a delivery request when render fails' {
            $payload = [PSCustomObject]@{ ScheduleId = 's1'; RunAt = '2026-01-01T06:00:00Z' }
            try {
                Invoke-ScheduledReport `
                    -JobPayload      $payload `
                    -ScheduleRepo    (New-ScheduleRepo) `
                    -ReportRepo      (New-ReportRepo) `
                    -RenderPort      (New-RenderPort -ShouldFail $true) `
                    -DeliveryChannel (New-DeliveryChannel)
            }
            catch { }
            $script:DeliveryRequests.Count | Should -Be 0
        }
    }

    Context 'Validation' {
        It 'Throws when ScheduleId is missing from payload' {
            $payload = [PSCustomObject]@{ RunAt = '2026-01-01T06:00:00Z' }
            { Invoke-ScheduledReport `
                -JobPayload      $payload `
                -ScheduleRepo    (New-ScheduleRepo) `
                -ReportRepo      (New-ReportRepo) `
                -RenderPort      (New-RenderPort) `
                -DeliveryChannel (New-DeliveryChannel) } | Should -Throw -ExceptionType ([System.ArgumentException])
        }

        It 'Throws when schedule is not found in the repo' {
            $emptyRepo = New-ScheduleRepo -Schedule $null
            Add-Member -InputObject $emptyRepo -MemberType ScriptMethod -Name 'GetSchedule' -Value {
                param($id) return $null
            } -Force

            $payload = [PSCustomObject]@{ ScheduleId = 'missing'; RunAt = '2026-01-01T06:00:00Z' }
            { Invoke-ScheduledReport `
                -JobPayload      $payload `
                -ScheduleRepo    $emptyRepo `
                -ReportRepo      (New-ReportRepo) `
                -RenderPort      (New-RenderPort) `
                -DeliveryChannel (New-DeliveryChannel) } | Should -Throw -ExceptionType ([System.InvalidOperationException])
        }
    }
}
