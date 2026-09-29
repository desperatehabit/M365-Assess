BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Manage-WebhookSubscription.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/manage-webhooks.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Manage-WebhookSubscription worker (T-0625)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-ManageWebhookSubscription -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ManageWebhooksJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'list' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{ id = 'sub-1'; resource = 'users'; notificationUrl = 'https://portal.example/v1/webhooks/notify'; expirationDateTime = '2099-01-01T00:00:00Z' },
                        @{ id = 'sub-2'; resource = 'groups'; notificationUrl = 'https://portal.example/v1/webhooks/notify'; expirationDateTime = '2020-01-01T00:00:00Z' }
                    )
                }
            }
        }

        It 'returns subscriptions with computed state' {
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'list'
            $res.success | Should -BeTrue
            $res.subscriptions.Count | Should -Be 2
            $res.subscriptions[0].id | Should -Be 'sub-1'
            $res.subscriptions[0].state | Should -Be 'active'
            $res.subscriptions[1].state | Should -Be 'expired'
        }

        It 'flags a subscription expiring within the threshold' {
            $soon = (Get-Date).AddHours(1).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ value = @(@{ id = 'sub-3'; resource = 'policies'; expirationDateTime = $soon }) }
            }
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'list'
            $res.subscriptions[0].state | Should -Be 'expiring'
        }

        It 'returns an empty list when the tenant has no subscriptions' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ value = @() }
            }
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'list'
            $res.success | Should -BeTrue
            $res.subscriptions.Count | Should -Be 0
        }
    }

    Context 'create' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'POST') {
                    return @{
                        id = 'sub-new'
                        resource = $Body.resource
                        notificationUrl = $Body.notificationUrl
                        expirationDateTime = $Body.expirationDateTime
                        clientState = $Body.clientState
                    }
                }
                return @{}
            }
        }

        It 'creates a subscription with a generated clientState and returns an audit event' {
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'create' -Resource 'users' -NotificationUrl 'https://portal.example/v1/webhooks/notify'
            $res.success | Should -BeTrue
            $res.subscription.id | Should -Be 'sub-new'
            $res.subscription.resource | Should -Be 'users'
            $res.subscription.clientState | Should -Not -BeNullOrEmpty
            $res.subscription.state | Should -Be 'active'
            $res.auditEvent.action | Should -Be 'webhook.subscription.create'
            $res.auditEvent.targetId | Should -Be 'sub-new'
        }

        It 'posts the change types, resource, and expiration to Graph' {
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'create' -Resource 'groups' -NotificationUrl 'https://portal.example/v1/webhooks/notify'
            $res.success | Should -BeTrue
            Assert-MockCalled Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'POST' -and $Uri -eq '/v1.0/subscriptions' } -Scope It
        }

        It 'rejects a resource outside the required set' {
            { Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'create' -Resource 'messages' -NotificationUrl 'https://portal.example/v1/webhooks/notify' } | Should -Throw '*users, groups, policies*'
        }

        It 'rejects a missing notification URL' {
            { Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'create' -Resource 'users' } | Should -Throw '*NotificationUrl*'
        }
    }

    Context 'renew' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'PATCH') {
                    return @{ id = 'sub-1'; resource = 'users'; expirationDateTime = $Body.expirationDateTime }
                }
                return @{}
            }
        }

        It 'patches the expiration and returns an audit event' {
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'renew' -SubscriptionId 'sub-1'
            $res.success | Should -BeTrue
            $res.subscription.id | Should -Be 'sub-1'
            $res.subscription.state | Should -Be 'active'
            $res.auditEvent.action | Should -Be 'webhook.subscription.renew'
        }

        It 'raises an alert and returns the alert event when the renewal fails' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                throw 'Resource not found'
            }
            $alerted = $null
            $raiseAlert = { param($alertEvent) $script:alerted = $alertEvent }
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'renew' -SubscriptionId 'sub-1' -RaiseAlert $raiseAlert
            $res.success | Should -BeFalse
            $res.alerted | Should -BeTrue
            $res.alertEvent.kind | Should -Be 'webhook.renewal_failed'
            $res.alertEvent.severity | Should -Be 'High'
            $res.alertEvent.subscriptionId | Should -Be 'sub-1'
            $res.alertEvent.reason | Should -Be 'Resource not found'
            $script:alerted.kind | Should -Be 'webhook.renewal_failed'
            $res.auditEvent.action | Should -Be 'webhook.subscription.renew'
            $res.auditEvent.note | Should -Match 'renew failed'
        }

        It 'requires a subscription id' {
            { Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'renew' } | Should -Throw '*SubscriptionId*'
        }
    }

    Context 'recreate' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET') {
                    return @{ id = 'sub-1'; resource = 'users'; notificationUrl = 'https://portal.example/v1/webhooks/notify'; clientState = 'state-1' }
                }
                if ($Method -eq 'POST') {
                    return @{ id = 'sub-new'; resource = $Body.resource; notificationUrl = $Body.notificationUrl; clientState = $Body.clientState; expirationDateTime = $Body.expirationDateTime }
                }
                return @{}
            }
        }

        It 'deletes the old subscription and creates a fresh one with the same resource and clientState' {
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'recreate' -SubscriptionId 'sub-1'
            $res.success | Should -BeTrue
            $res.subscription.id | Should -Be 'sub-new'
            $res.subscription.resource | Should -Be 'users'
            $res.subscription.clientState | Should -Be 'state-1'
            $res.auditEvent.action | Should -Be 'webhook.subscription.recreate'
            $res.auditEvent.before.previousSubscriptionId | Should -Be 'sub-1'
            Assert-MockCalled Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'DELETE' -and $Uri -eq '/v1.0/subscriptions/sub-1' } -Scope It
        }
    }

    Context 'delete' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET') {
                    return @{ id = 'sub-1'; resource = 'users' }
                }
                return @{}
            }
        }

        It 'deletes the subscription and returns an audit event' {
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'delete' -SubscriptionId 'sub-1'
            $res.success | Should -BeTrue
            $res.deleted | Should -Be 'sub-1'
            $res.auditEvent.action | Should -Be 'webhook.subscription.delete'
            Assert-MockCalled Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'DELETE' -and $Uri -eq '/v1.0/subscriptions/sub-1' } -Scope It
        }
    }

    Context 'test' {
        It 'reports a healthy subscription that is not expired' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ id = 'sub-1'; resource = 'users'; expirationDateTime = '2099-01-01T00:00:00Z' }
            }
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'test' -SubscriptionId 'sub-1'
            $res.success | Should -BeTrue
            $res.healthy | Should -BeTrue
            $res.subscription.state | Should -Be 'active'
        }

        It 'reports an unhealthy subscription once expired' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ id = 'sub-1'; resource = 'users'; expirationDateTime = '2020-01-01T00:00:00Z' }
            }
            $res = Invoke-ManageWebhookSubscription -TenantId 'tenant-test' -Action 'test' -SubscriptionId 'sub-1'
            $res.healthy | Should -BeFalse
            $res.subscription.state | Should -Be 'expired'
        }
    }

    Context 'job envelope' {
        It 'reads the tenant, action, and fields from the job file' {
            $path = Join-Path $TestDrive ("job-{0}.json" -f [guid]::NewGuid())
            @{
                tenantId = 'tenant-test'
                action = 'list'
                subscriptionId = 'sub-1'
                resource = 'users'
                notificationUrl = 'https://portal.example/v1/webhooks/notify'
            } | ConvertTo-Json | Set-Content -LiteralPath $path

            $job = Read-ManageWebhooksJob -Path $path
            $job['TenantId'] | Should -Be 'tenant-test'
            $job['Action'] | Should -Be 'list'
            $job['SubscriptionId'] | Should -Be 'sub-1'
        }

        It 'refuses a job without a tenant id' {
            $path = Join-Path $TestDrive ("job-{0}.json" -f [guid]::NewGuid())
            @{ action = 'list' } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-ManageWebhooksJob -Path $path } | Should -Throw '*tenantId*'
        }
    }
}
