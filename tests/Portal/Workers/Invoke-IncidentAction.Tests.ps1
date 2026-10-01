BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-IncidentAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-incident-action.ps1'

    $script:incident = @{
        id             = 'incident-1'
        status         = 'active'
        classification = 'truePositive'
        assignedTo     = $null
    }

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $ContentType)
    }

    . $script:worker
}

Describe 'Invoke-IncidentAction worker (T-0546)' {

    BeforeEach {
        $script:incident.status = 'active'
        $script:incident.classification = 'truePositive'
        $script:incident.assignedTo = $null

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body, $ContentType)
            if ($Method -eq 'PATCH' -and $Body) {
                $bodyObject = $Body | ConvertFrom-Json
                if ($null -ne $bodyObject.status) { $script:incident.status = [string]$bodyObject.status }
                if ($null -ne $bodyObject.classification) { $script:incident.classification = [string]$bodyObject.classification }
            }
            return $script:incident
        }
    }

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-IncidentAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-IncidentActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'writes back only status and classification through PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match "Method\s+PATCH"
            $source | Should -Match 'status'
            $source | Should -Match 'classification'
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-IncidentAction.ps1'
            $entrySource | Should -Match 'Invoke-IncidentAction -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }

        It 'entrypoint forwards the job actor and correlation id to the worker' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match '\$Actor\s*=\s*\$job\[''Actor''\]'
            $entrySource | Should -Match '\$CorrelationId\s*=\s*\$job\[''CorrelationId''\]'
            $entrySource | Should -Match '-Actor\s+\$Actor\s+-CorrelationId\s+\$CorrelationId'
        }
    }

    Context 'supported write-back (SPEC §11 item 1)' {
        It 'writes a status change back to Graph with PATCH and captures before/after' {
            $result = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled'

            $result.status | Should -Be 'applied'
            $result.writeBack | Should -Be $true
            $result.from | Should -Be 'active'
            $result.to | Should -Be 'resolved'
            $result.before.status | Should -Be 'active'
            $result.after.status | Should -Be 'resolved'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' -and $Uri -like '*security/incidents/incident-1*' }
        }

        It 'writes a classification change back to Graph with PATCH' {
            $result = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'classify' -Value 'falsePositive' -Reason 'Verified benign'

            $result.status | Should -Be 'applied'
            $result.writeBack | Should -Be $true
            $result.from | Should -Be 'truePositive'
            $result.to | Should -Be 'falsePositive'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' -and $Body -match 'falsePositive' }
        }

        It 'sends the canonical Graph value in the PATCH body' {
            $null = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'redirected' -Reason 'Moved to another queue'

            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' -and $Body -match '"status"\s*:\s*"redirected"' }
        }
    }

    Context 'unsupported field fallback (SPEC §11 item 1)' {
        It 'falls back to a portal-only state change for assign with no Graph write' {
            $result = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'assign' -Value 'analyst-2' -Reason 'Reassigned'

            $result.status | Should -Be 'applied'
            $result.writeBack | Should -Be $false
            $result.from | Should -Be ''
            $result.to | Should -Be 'analyst-2'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'GET' }
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'records a comment as a portal note with no Graph write' {
            $result = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'comment' -Comment 'Escalating to tier 2' -Actor 'analyst-1'

            $result.status | Should -Be 'applied'
            $result.writeBack | Should -Be $false
            $result.from | Should -Be ''
            $result.to | Should -Be ''
            $result.note.body | Should -Be 'Escalating to tier 2'
            $result.note.author | Should -Be 'analyst-1'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }
    }

    Context 'gating (EPIC-006)' {
        It 'refuses to resolve without explicit confirmation and issues no write' {
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -Reason 'Handled' } | Should -Throw
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'refuses an unknown action' {
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'delete' -Reason 'Nope' } | Should -Throw
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'refuses an unknown status value' {
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'closed' -Reason 'Nope' } | Should -Throw
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'requires the tenant, incident, and action' {
            { Invoke-IncidentAction -TenantId '' -IncidentId 'incident-1' -Action 'status' -Value 'active' -Reason 'x' } | Should -Throw
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId '' -Action 'status' -Value 'active' -Reason 'x' } | Should -Throw
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action '' -Value 'active' -Reason 'x' } | Should -Throw
        }

        It 'requires a value for status, classify, and assign' {
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Reason 'x' } | Should -Throw
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'classify' -Reason 'x' } | Should -Throw
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'assign' -Reason 'x' } | Should -Throw
        }

        It 'requires a comment body' {
            { Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'comment' } | Should -Throw
        }

        It 'plans without a Graph write or audit when DryRun' {
            $result = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -DryRun -Reason 'Handled'

            $result.status | Should -Be 'planned'
            $result.from | Should -Be 'active'
            $result.to | Should -Be 'resolved'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'fails cleanly when the incident does not exist' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $ContentType)
                return $null
            }

            $result = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled'

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'not found'
        }
    }

    Context 'audit' {
        It 'records an audit event with from/to/by/reason on apply' {
            $script:audits = [System.Collections.Generic.List[object]]::new()
            $null = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled' -Actor 'analyst-1' -CorrelationId 'corr-1' -WriteAudit { param($AuditEvent) $script:audits.Add($AuditEvent) }

            $script:audits.Count | Should -Be 1
            $script:audits[0].action | Should -Be 'incidents.action:status'
            $script:audits[0].incidentId | Should -Be 'incident-1'
            $script:audits[0].result | Should -Be 'success'
            $script:audits[0].from | Should -Be 'active'
            $script:audits[0].to | Should -Be 'resolved'
            $script:audits[0].actor | Should -Be 'analyst-1'
            $script:audits[0].reason | Should -Be 'Handled'
            $script:audits[0].correlationId | Should -Be 'corr-1'
        }

        It 'records a failure audit event when the Graph write fails' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $ContentType)
                if ($Method -eq 'PATCH') { throw 'graph rejected the patch' }
                return $script:incident
            }
            $script:audits = [System.Collections.Generic.List[object]]::new()

            $result = Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled' -Actor 'analyst-1' -WriteAudit { param($AuditEvent) $script:audits.Add($AuditEvent) }

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'graph rejected the patch'
            $script:audits.Count | Should -Be 1
            $script:audits[0].result | Should -Be 'failure'
        }
    }

    Context 'job envelope' {
        It 'reads a job envelope into action parameters' {
            $jobPath = Join-Path $TestDrive 'incident-action-job.json'
            @{
                schemaVersion   = 'v1'
                tenantId      = 'tenant-a'
                correlationId = 'corr-1'
                payload       = @{
                    incidentId = 'incident-1'
                    action     = 'status'
                    value      = 'resolved'
                    reason     = 'Handled'
                    confirm    = $true
                    actor      = 'analyst-1'
                }
            } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jobPath

            $job = Read-IncidentActionJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-a'
            $job['IncidentId'] | Should -Be 'incident-1'
            $job['Action'] | Should -Be 'status'
            $job['Value'] | Should -Be 'resolved'
            $job['Reason'] | Should -Be 'Handled'
            $job['Confirmed'] | Should -Be $true
            $job['Actor'] | Should -Be 'analyst-1'
            $job['CorrelationId'] | Should -Be 'corr-1'
        }

        It 'refuses an envelope with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'incident-action-job.json'
            @{ schemaVersion = 'v2'; tenantId = 'tenant-a'; payload = @{ incidentId = 'incident-1'; action = 'status' } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jobPath

            { Read-IncidentActionJob -Path $jobPath } | Should -Throw
        }
    }
}
