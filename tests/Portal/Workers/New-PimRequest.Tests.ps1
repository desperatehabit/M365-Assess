BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/New-PimRequest.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'New-PimRequest worker (T-0245)' {

    Context 'the worker functions' {
        It 'ships the functions' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command New-PimRequest -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-PimRequestJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'ships an entrypoint that signs in to the tenant' {
            $entrypoint = Join-Path $script:repoRoot 'portal/workers/new-pim-request.ps1'
            Test-Path -LiteralPath $entrypoint | Should -BeTrue
            (Get-Content -LiteralPath $entrypoint -Raw) | Should -Match 'Connect-WorkerTenant -JobFile'
        }
    }

    Context 'Mandatory justification' {
        It 'rejects request without justification' {
            {
                New-PimRequest -TenantId 'tenant-test' -PrincipalId 'u-1' -RoleId 'r-1' -Justification ''
            } | Should -Throw '*justification is required*'
        }
    }

    Context 'Submission and state transitions' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    id = 'req-123'
                    status = 'Granted'
                }
            }
        }

        It 'submits valid request and activates directly when approval not required' {
            $result = New-PimRequest -TenantId 'tenant-test' -PrincipalId 'u-1' -RoleId 'r-1' -Justification 'Emergency incident INC-123'

            $result.state | Should -Be 'active'
            $result.id | Should -Be 'req-123'
            $result.startsAt | Should -Not -BeNullOrEmpty
            $result.endsAt | Should -Not -BeNullOrEmpty
            Assert-MockCalled Invoke-MgGraphRequest -Times 1 -ParameterFilter { $Method -eq 'POST' }
        }

        It 'enters pending state when approval is configured' {
            $result = New-PimRequest -TenantId 'tenant-test' -PrincipalId 'u-1' -RoleId 'r-1' -Justification 'Planned maintenance' -ApprovalRequired

            $result.state | Should -Be 'pending'
            $result.startsAt | Should -BeNullOrEmpty
        }
    }

    Context 'App-only action mapping (T-0831)' {
        BeforeEach {
            $script:pimCalls = [System.Collections.Generic.List[object]]::new()
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                $script:pimCalls.Add([pscustomobject]@{ Method = $Method; Uri = $Uri; Body = $Body })
                @{ id = 'req-123'; status = 'Granted' }
            }
        }

        It 'maps activate to AdminAssign because app-only cannot SelfActivate' {
            New-PimRequest -TenantId 'tenant-test' -PrincipalId 'u-1' -RoleId 'r-1' -Justification 'Emergency incident INC-123' | Out-Null

            ($script:pimCalls[0].Body | ConvertFrom-Json).action | Should -Be 'AdminAssign'
        }

        It 'maps deactivate to AdminRemove because app-only cannot SelfDeactivate' {
            New-PimRequest -TenantId 'tenant-test' -PrincipalId 'u-1' -RoleId 'r-1' -Action deactivate -Justification 'Emergency incident INC-123' | Out-Null

            ($script:pimCalls[0].Body | ConvertFrom-Json).action | Should -Be 'AdminRemove'
        }

        It 'extends to the supplied new end rather than counting from now' {
            New-PimRequest -TenantId 'tenant-test' -PrincipalId 'u-1' -RoleId 'r-1' -Action extend -DurationHours 4 -NewEndsAt '2026-09-26T20:00:00Z' -Justification 'Planned maintenance' | Out-Null

            $body = $script:pimCalls[0].Body | ConvertFrom-Json
            $body.action | Should -Be 'AdminExtend'
            $body.scheduleInfo.expiration.type | Should -Be 'AfterDateTime'
            ([datetime]$body.scheduleInfo.expiration.endDateTime).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') |
                Should -Be '2026-09-26T20:00:00Z'
        }
    }

    Context 'Reading a request back so the portal can mirror Entra (T-0831)' {
        It 'GETs the request and maps an approved status to active' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                @{ id = 'req-123'; status = 'Granted' }
            }

            $result = Get-PimRequestStatus -TenantId 'tenant-test' -RequestId 'req-123'

            $result.state | Should -Be 'active'
            Assert-MockCalled Invoke-MgGraphRequest -Times 1 -ParameterFilter {
                $Method -eq 'GET' -and $Uri -eq '/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/req-123'
            }
        }

        It 'maps PendingApproval to pending and Denied to rejected' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                @{ id = 'req-123'; status = 'PendingApproval' }
            }
            (Get-PimRequestStatus -TenantId 'tenant-test' -RequestId 'req-123').state | Should -Be 'pending'

            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                @{ id = 'req-123'; status = 'Denied' }
            }
            (Get-PimRequestStatus -TenantId 'tenant-test' -RequestId 'req-123').state | Should -Be 'rejected'
        }
    }
}
