BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:builderPage = Join-Path $script:repoRoot 'portal/web/src/app/tenant-administration/alerts/builder/page.tsx'
    $script:builderTest = Join-Path $script:repoRoot 'portal/web/src/app/tenant-administration/alerts/builder/builder.test.tsx'
    $script:notificationsPage = Join-Path $script:repoRoot 'portal/web/src/app/settings/notifications/page.tsx'
    $script:notificationsTest = Join-Path $script:repoRoot 'portal/web/tests/NotificationsPage.test.tsx'
    $script:uiFiles = @($script:builderPage, $script:notificationsPage)
}

Describe 'Custom alert builder and Notifications UI (T-0569)' {

    Context 'the builder route' {
        It 'exists and composes tenant, criteria, and notification cards' {
            Test-Path -LiteralPath $script:builderPage | Should -BeTrue
            $source = Get-Content -LiteralPath $script:builderPage -Raw
            $source | Should -Match 'builder-tenant-card'
            $source | Should -Match 'builder-criteria-card'
            $source | Should -Match 'builder-actions-card'
            $source | Should -Match 'Tenant'
            $source | Should -Match 'Alert criteria'
            $source | Should -Match 'Notification settings'
        }

        It 'supports preset autocomplete and dynamic condition rows' {
            $source = Get-Content -LiteralPath $script:builderPage -Raw
            $source | Should -Match 'ALERT_PRESETS'
            $source | Should -Match 'datalist'
            $source | Should -Match 'builder-add-condition'
            $source | Should -Match 'builder-remove-condition'
            foreach ($operator in @('eq', 'ne', 'like', 'match', 'gt', 'in', 'contains')) {
                $source | Should -Match ([regex]::Escape("`"$operator`""))
            }
        }

        It 'validates operators through the shared contract and rejects invalid input' {
            $source = Get-Content -LiteralPath $script:builderPage -Raw
            $source | Should -Match 'isAlertConditionOperator'
            $source | Should -Match 'validateConditionRows'
            $source | Should -Match 'is not supported'
        }

        It 'saves the composed rule through POST /v1/alert-rules' {
            $source = Get-Content -LiteralPath $script:builderPage -Raw
            $source | Should -Match 'ALERT_RULES_API_PATH = "/v1/alert-rules"'
            $source | Should -Match 'method: "POST"'
            $source | Should -Match 'buildAlertRulePayload'
            $source | Should -Match 'tenantId'
            $source | Should -Match 'actions'
        }

        It 'surfaces script mode with the high-privilege admin gate' {
            $source = Get-Content -LiteralPath $script:builderPage -Raw
            $source | Should -Match 'builder-script-mode-warning'
            $source | Should -Match 'high privilege'
            $source | Should -Match 'sandboxed'
            $source | Should -Match 'SCRIPT_MODE_ADMIN_PERMISSION'
            $source | Should -Match 'resolvePermission'
            $source | Should -Match 'disabled=\{isAdmin !== true\}'
        }
    }

    Context 'the notifications route' {
        It 'exists and edits channel config through PUT /v1/notifications' {
            Test-Path -LiteralPath $script:notificationsPage | Should -BeTrue
            $source = Get-Content -LiteralPath $script:notificationsPage -Raw
            $source | Should -Match 'NOTIFICATIONS_API_PATH = "/v1/notifications"'
            $source | Should -Match 'method: "PUT"'
            $source | Should -Match 'updateNotificationChannel'
            $source | Should -Match 'notification-enabled-'
        }

        It 'triggers a test-send and shows the result' {
            $source = Get-Content -LiteralPath $script:notificationsPage -Raw
            $source | Should -Match 'NOTIFICATIONS_TEST_API_PATH = "/v1/notifications/test"'
            $source | Should -Match 'testNotificationChannel'
            $source | Should -Match 'notification-test-result-'
            $source | Should -Match 'describeNotificationTestResult'
        }

        It 'exposes email, webhook, PSA, and Slack channels' {
            $source = Get-Content -LiteralPath $script:notificationsPage -Raw
            foreach ($channel in @('email', 'webhook', 'psa', 'slack')) {
                $source | Should -Match ([regex]::Escape("`"$channel`""))
            }
        }
    }

    Context 'theme tokens and tests' {
        It 'styles only from report tokens, with no colour literals' {
            foreach ($file in $script:uiFiles) {
                $source = Get-Content -LiteralPath $file -Raw
                $source | Should -Match 'var\(--'
                $source | Should -Not -Match '#[0-9a-fA-F]{3,8}\b'
                $source | Should -Not -Match '\brgba?\s*\('
                $source | Should -Not -Match '\bhsla?\s*\('
            }
        }

        It 'ships a builder regression test that covers save, operators, and script mode' {
            Test-Path -LiteralPath $script:builderTest | Should -BeTrue
            $source = Get-Content -LiteralPath $script:builderTest -Raw
            $source | Should -Match 'composes tenant, criteria rows, and actions and saves a working rule'
            $source | Should -Match 'validates operators against the shared contract'
            $source | Should -Match 'disables it for non-admin callers'
        }

        It 'ships a notifications regression test that covers config and test-send' {
            Test-Path -LiteralPath $script:notificationsTest | Should -BeTrue
            $source = Get-Content -LiteralPath $script:notificationsTest -Raw
            $source | Should -Match 'saves it through PUT /v1/notifications'
            $source | Should -Match 'triggers a test-send'
        }
    }
}
