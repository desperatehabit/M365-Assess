# Invoke-ScheduledReport.ps1
# EPIC-005 SPEC.md §4.3, §11.4 — scheduled report generation and delivery.
#
# Worker handler for the `report` job type.  When a Schedule of type `report`
# fires (scheduled by EPIC-007, which is not yet authored), this worker:
#   1. Reads the schedule's template and tenant from the repository seam.
#   2. Resolves the report data via Resolve-ReportBinding (T-0087).
#   3. Invokes the render path (T-0084 / Invoke-ReportRender) to produce a PDF.
#   4. Stores a GeneratedReport metadata record via the repository seam.
#   5. Emits a delivery request to the EPIC-029 channel contract.
#
# Idempotency: a `scheduleId + runAt` composite key prevents duplicate
# GeneratedReport rows when a job is retried after a transient failure.
# A failed render marks the job failed without a partial row.
#
# Dependencies:
#   - Schedule entity, cron tick, and queue are EPIC-007's scope.
#   - Storage and CRUD for GeneratedReport are T-0083's scope.
#   - Delivery channels are EPIC-029's scope.
#   - This worker implements only the `report` job handler and reads the
#     schedule through the repository seam.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ─── Public entry point ────────────────────────────────────────────────

function Invoke-ScheduledReport {
    <#
    .SYNOPSIS
        Handles a `report` job fired by the EPIC-007 scheduler.
    .DESCRIPTION
        Resolves the schedule's template/tenant, renders the report, persists
        a GeneratedReport metadata record, and emits a delivery request.
        Idempotency is enforced via the ScheduleId + RunAt composite key so
        retrying a failed job does not produce a duplicate row.

        All I/O is performed through injected port objects (ScheduleRepo,
        ReportRepo, RenderPort, DeliveryChannel) so the handler is testable
        without a live database or PDF renderer.
    .PARAMETER JobPayload
        A PSCustomObject or hashtable with required keys:
          - ScheduleId (string): the EPIC-007 Schedule id.
          - RunAt      (string): ISO-8601 timestamp from the scheduler tick.
    .PARAMETER ScheduleRepo
        Repository seam.  Must expose:
          - GetSchedule(id): returns a PSCustomObject with TemplateId, TenantId,
            and BrandingConfig (nullable).
    .PARAMETER ReportRepo
        Repository seam.  Must expose:
          - FindByScheduleRunAt(scheduleId, runAt): returns null or an existing
            GeneratedReport row (idempotency check).
          - Create(record): persists a new GeneratedReport row and returns it.
          - MarkFailed(id): marks the row as failed without altering artifactRef.
    .PARAMETER RenderPort
        Render seam.  Must expose:
          - RenderTemplate(templateId, tenantId, brandingConfig): returns an
            object with ArtifactRef (string) on success, throws on failure.
    .PARAMETER DeliveryChannel
        Delivery seam (EPIC-029 contract).  Must expose:
          - SendDeliveryRequest(scheduleId, generatedReportId, tenantId):
            enqueues delivery without blocking the handler.
    .OUTPUTS
        [PSCustomObject] with:
          GeneratedReportId – id of the persisted row (new or existing)
          WasDuplicate      – $true when the idempotency check short-circuited
          Status            – 'succeeded' | 'failed'
    .EXAMPLE
        $payload  = [PSCustomObject]@{ ScheduleId = 's1'; RunAt = '2026-01-01T06:00:00Z' }
        $result   = Invoke-ScheduledReport -JobPayload $payload -ScheduleRepo $repo ...
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [object]$JobPayload,

        [Parameter(Mandatory)]
        [object]$ScheduleRepo,

        [Parameter(Mandatory)]
        [object]$ReportRepo,

        [Parameter(Mandatory)]
        [object]$RenderPort,

        [Parameter(Mandatory)]
        [object]$DeliveryChannel
    )

    $scheduleId = Get-Property -Object $JobPayload -Name 'ScheduleId'
    $runAt      = Get-Property -Object $JobPayload -Name 'RunAt'

    if (-not $scheduleId) {
        throw [System.ArgumentException]::new('report_job.missing_schedule_id: ScheduleId is required in the job payload.')
    }
    if (-not $runAt) {
        throw [System.ArgumentException]::new('report_job.missing_run_at: RunAt is required in the job payload.')
    }

    # ── Idempotency: check for an existing row before doing any work ──────────
    $existing = $ReportRepo.FindByScheduleRunAt($scheduleId, $runAt)
    if ($null -ne $existing) {
        return [PSCustomObject]@{
            GeneratedReportId = (Get-Property -Object $existing -Name 'Id')
            WasDuplicate      = $true
            Status            = (Get-Property -Object $existing -Name 'Status')
        }
    }

    # ── Resolve the schedule ───────────────────────────────────────────────────
    $schedule = $ScheduleRepo.GetSchedule($scheduleId)
    if ($null -eq $schedule) {
        throw [System.InvalidOperationException]::new("report_job.schedule_not_found: Schedule '$scheduleId' not found.")
    }

    $templateId    = Get-Property -Object $schedule -Name 'TemplateId'
    $tenantId      = Get-Property -Object $schedule -Name 'TenantId'
    $brandingConfig = Get-Property -Object $schedule -Name 'BrandingConfig'

    if (-not $templateId) {
        throw [System.InvalidOperationException]::new("report_job.missing_template_id: Schedule '$scheduleId' has no TemplateId.")
    }
    if (-not $tenantId) {
        throw [System.InvalidOperationException]::new("report_job.missing_tenant_id: Schedule '$scheduleId' has no TenantId.")
    }

    # ── Create the GeneratedReport row in 'running' state before rendering ────
    $reportId = [System.Guid]::NewGuid().ToString()
    $null = $ReportRepo.Create([PSCustomObject]@{
        Id          = $reportId
        ScheduleId  = $scheduleId
        RunAt       = $runAt
        TemplateId  = $templateId
        TenantId    = $tenantId
        Status      = 'running'
        ArtifactRef = $null
    })

    # ── Render ────────────────────────────────────────────────────────────────
    try {
        $renderResult = $RenderPort.RenderTemplate($templateId, $tenantId, $brandingConfig)
        $artifactRef  = Get-Property -Object $renderResult -Name 'ArtifactRef'

        $null = $ReportRepo.MarkSucceeded($reportId, $artifactRef)

        # ── Emit delivery request (EPIC-029 channel contract) ─────────────────
        $null = $DeliveryChannel.SendDeliveryRequest($scheduleId, $reportId, $tenantId)

        return [PSCustomObject]@{
            GeneratedReportId = $reportId
            WasDuplicate      = $false
            Status            = 'succeeded'
        }
    }
    catch {
        # A failed render must not leave a partial or 'running' row.
        try { $null = $ReportRepo.MarkFailed($reportId) } catch { <# swallow secondary failure #> }
        throw
    }
}

#endregion

#region ─── Internal helpers ─────────────────────────────────────────────────

function Get-Property {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Object -is [hashtable]) {
        if ($Object.ContainsKey($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

#endregion
