BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-AlertAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-alert-action.ps1'

    $script:alert = @{
        id            = 'alert-1'
        status        = 'new'
        assignedTo    = $null
        severity      = 'high'
        serviceSource = 'microsoftDefenderForEndpoint'
        comments      = @()
    }

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $ContentType)
    }

    . $script:worker
}

Describe 'Invoke-AlertAction worker (T-0548)' {

    BeforeEach {
        $script:alert.status = 'new'
        $script:alert.assignedTo = $null
        $script:alert.serviceSource = 'microsoftDefenderForEndpoint'
        $script:alert.comments = @()

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body, $ContentType)
            if ($Method -eq 'POST' -and $Uri -like '*security/incidents*') {
                return @{ id = 'incident-9' }
            }
            if ($Method -eq 'PATCH' -and $Body) {
                $bodyObject = $Body | ConvertFrom-Json
                if ($null -ne $bodyObject.status) { $script:alert.status = [string]$bodyObject.status }
                if ($null -ne $bodyObject.assignedTo) { $script:alert.assignedTo = [string]$bodyObject.assignedTo }
                if ($null -ne $bodyObject.comments) { $script:alert.comments = @($bodyObject.comments) }
            }
            return $script:alert
        }
    }

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-AlertAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-AlertActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the action set, write-back set, and create-incident sources' {
            Get-AlertActions | Should -Be @('status', 'assign', 'comment', 'create-incident')
            Get-AlertActionWriteBackActions | Should -Be @('status', 'assign', 'comment')
            Get-AlertCreateIncidentSources | Should -Be @('defender', 'mdo')
            (Test-AlertActionSupported -Source 'graph' -Action 'create-incident') | Should -BeFalse
            (Test-AlertActionSupported -Source 'defender' -Action 'create-incident') | Should -BeTrue
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-AlertAction.ps1'
            $entrySource | Should -Match 'Invoke-AlertAction -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'supported write-back (SPEC §11 item 1)' {
        It 'writes a status change back to alerts_v2 with PATCH and captures before/after' {
            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'inProgress' -Reason 'Working it'

            $result.status | Should -Be 'applied'
            $result.writeBack | Should -BeTrue
            $result.from | Should -Be 'new'
            $result.to | Should -Be 'inProgress'
            $result.after.status | Should -Be 'inProgress'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' -and $Uri -like '*security/alerts_v2/alert-1*' }
        }

        It 'writes an assignee back to alerts_v2 with PATCH' {
            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'assign' -Value 'analyst-2' -Reason 'Reassigned'

            $result.status | Should -Be 'applied'
            $result.writeBack | Should -BeTrue
            $result.to | Should -Be 'analyst-2'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' -and $Body -match 'analyst-2' }
        }

        It 'appends a comment through the alerts_v2 comments collection' {
            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'comment' -Comment 'Escalating to tier 2' -Actor 'analyst-1'

            $result.status | Should -Be 'applied'
            $result.writeBack | Should -BeTrue
            $result.note.body | Should -Be 'Escalating to tier 2'
            $result.note.author | Should -Be 'analyst-1'
            $script:alert.comments | Should -Contain 'Escalating to tier 2'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' -and $Body -match 'Escalating to tier 2' }
        }

        It 'creates an incident for a supported source and returns its id' {
            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'create-incident' -Value 'Investigate alert-1' -Reason 'Promoting' -Confirmed

            $result.status | Should -Be 'applied'
            $result.incidentId | Should -Be 'incident-9'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -like '*security/incidents*' }
        }
    }

    Context 'unsupported write refusal' {
        It 'refuses create-incident for a source that does not support it and issues no write' {
            $script:alert.serviceSource = 'azureAdIdentityProtection'

            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'create-incident' -Value 'Investigate' -Reason 'Promoting' -Confirmed } | Should -Throw '*alerts.unsupported_action*'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'GET' }
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'still allows status on a source that cannot create an incident' {
            $script:alert.serviceSource = 'azureAdIdentityProtection'

            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled'
            $result.status | Should -Be 'applied'
        }
    }

    Context 'gating (EPIC-006)' {
        It 'refuses to resolve without explicit confirmation and issues no write' {
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'resolved' -Reason 'Handled' } | Should -Throw '*alerts.confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'refuses to create an incident without explicit confirmation' {
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'create-incident' -Value 'Investigate' -Reason 'Promoting' } | Should -Throw '*alerts.confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        }

        It 'refuses an unknown action and an unknown status value' {
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'delete' -Reason 'Nope' } | Should -Throw '*alerts.unknown_action*'
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'closed' -Reason 'Nope' } | Should -Throw '*alerts.unknown_value*'
        }

        It 'requires a value for status, assign, and create-incident and a body for comment' {
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Reason 'x' } | Should -Throw '*alerts.value_required*'
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'assign' -Reason 'x' } | Should -Throw '*alerts.value_required*'
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'create-incident' -Reason 'x' } | Should -Throw '*alerts.value_required*'
            { Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'comment' } | Should -Throw '*alerts.comment_required*'
        }

        It 'plans without a Graph write or audit when DryRun' {
            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'resolved' -DryRun -Reason 'Handled'

            $result.status | Should -Be 'planned'
            $result.from | Should -Be 'new'
            $result.to | Should -Be 'resolved'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'fails cleanly when the alert does not exist' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $ContentType)
                return $null
            }

            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled'

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'not found'
        }
    }

    Context 'audit' {
        It 'records an audit event with from/to/by/reason on apply' {
            $script:audits = [System.Collections.Generic.List[object]]::new()
            $null = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'inProgress' -Reason 'Working it' -Actor 'analyst-1' -CorrelationId 'corr-1' -WriteAudit { param($AuditEvent) $script:audits.Add($AuditEvent) }

            $script:audits.Count | Should -Be 1
            $script:audits[0].action | Should -Be 'alerts.action:status'
            $script:audits[0].alertId | Should -Be 'alert-1'
            $script:audits[0].result | Should -Be 'success'
            $script:audits[0].from | Should -Be 'new'
            $script:audits[0].to | Should -Be 'inProgress'
            $script:audits[0].actor | Should -Be 'analyst-1'
            $script:audits[0].reason | Should -Be 'Working it'
            $script:audits[0].correlationId | Should -Be 'corr-1'
        }

        It 'records a failure audit event when the Graph write fails' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $ContentType)
                if ($Method -eq 'PATCH') { throw 'graph rejected the patch' }
                return $script:alert
            }
            $script:audits = [System.Collections.Generic.List[object]]::new()

            $result = Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'inProgress' -Reason 'Working it' -Actor 'analyst-1' -WriteAudit { param($AuditEvent) $script:audits.Add($AuditEvent) }

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'graph rejected the patch'
            $script:audits.Count | Should -Be 1
            $script:audits[0].result | Should -Be 'failure'
        }
    }

    Context 'job envelope' {
        It 'reads a job envelope into action parameters' {
            $jobPath = Join-Path $TestDrive 'alert-action-job.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                correlationId = 'corr-1'
                payload       = @{
                    alertId = 'alert-1'
                    action  = 'create-incident'
                    value   = 'Investigate'
                    reason  = 'Promoting'
                    confirm = $true
                    actor   = 'analyst-1'
                }
            } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jobPath

            $job = Read-AlertActionJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-a'
            $job['AlertId'] | Should -Be 'alert-1'
            $job['Action'] | Should -Be 'create-incident'
            $job['Value'] | Should -Be 'Investigate'
            $job['Confirmed'] | Should -BeTrue
            $job['CorrelationId'] | Should -Be 'corr-1'
        }

        It 'refuses an envelope with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'alert-action-job.json'
            @{ schemaVersion = 'v2'; tenantId = 'tenant-a'; payload = @{ alertId = 'alert-1'; action = 'status' } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jobPath

            { Read-AlertActionJob -Path $jobPath } | Should -Throw
        }
    }
}
