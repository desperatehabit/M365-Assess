BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-EnrollmentProfile.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-enrollment-profile.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:now = [datetime]::new(2026, 9, 28, 12, 0, 0, [DateTimeKind]::Utc)

    function script:Invoke-FakeEnrollGraph {
        param($Method, $Uri, $Body)
        $script:graph.Add(@{ Method = $Method; Uri = $Uri; Body = $Body })
        switch -Regex ("$Method $Uri") {
            '^GET /beta/deviceManagement/depOnboardingSettings$' {
                return @{ value = @(
                        @{ id = 'dep-1'; tokenName = 'Corp ADE'; appleIdentifier = 'mdm@contoso.com'; tokenExpirationDateTime = '2026-10-10T00:00:00Z'; lastSuccessfulSyncDateTime = '2026-09-27T00:00:00Z' }
                    ) }
            }
            '^GET /beta/deviceManagement/depOnboardingSettings/dep-1/enrollmentProfiles$' {
                return @{ value = @(@{ '@odata.type' = '#microsoft.graph.depIOSEnrollmentProfile'; id = 'ios-1'; displayName = 'iPhone standard'; isDefault = $true }) }
            }
            '^GET /beta/deviceManagement/depOnboardingSettings/dep-1/enrollmentProfiles/ios-1$' {
                return @{ '@odata.type' = '#microsoft.graph.depIOSEnrollmentProfile'; id = 'ios-1'; displayName = 'iPhone standard'; requiresUserAuthentication = $true }
            }
            '^GET /beta/deviceManagement/androidDeviceOwnerEnrollmentProfiles$' {
                return @{ value = @(
                        @{ id = 'and-1'; displayName = 'Kiosk'; enrollmentMode = 'corporateOwnedDedicatedDevice'; tokenValue = 'SECRET-TOKEN'; qrCodeContent = 'SECRET-QR'; tokenExpirationDateTime = '2026-09-01T00:00:00Z'; enrolledDeviceCount = 4 }
                        @{ id = 'and-2'; displayName = 'Fully managed'; enrollmentMode = 'corporateOwnedFullyManaged'; tokenExpirationDateTime = '2027-09-01T00:00:00Z' }
                    ) }
            }
            '^GET /beta/deviceManagement/androidDeviceOwnerEnrollmentProfiles/and-1$' {
                return @{ id = 'and-1'; displayName = 'Kiosk'; enrollmentMode = 'corporateOwnedDedicatedDevice'; tokenValue = 'SECRET-TOKEN'; qrCodeImage = @{ value = 'SECRET-IMG' } }
            }
            '^GET ' { throw 'Response status code does not indicate success: NotFound (Not Found).' }
            '^POST /beta/deviceManagement/androidDeviceOwnerEnrollmentProfiles$' { return @{ id = 'and-9'; displayName = 'New'; tokenValue = 'SECRET-TOKEN' } }
            default { return $null }
        }
    }
}

Describe 'Set-EnrollmentProfile worker (T-0329)' {
    BeforeEach {
        $script:graph = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-MgGraphRequest { param($Method, $Uri, $Body) Invoke-FakeEnrollGraph -Method $Method -Uri $Uri -Body $Body }
    }

    Context 'Token status' {
        It 'classifies expiry as ok, expiring (under 30 days), expired, or unknown' {
            (Get-EnrollmentTokenState -ExpiresAt '2027-01-01T00:00:00Z' -Now $script:now).state | Should -Be 'ok'
            $soon = Get-EnrollmentTokenState -ExpiresAt '2026-10-10T00:00:00Z' -Now $script:now
            $soon.state | Should -Be 'expiring'
            $soon.daysRemaining | Should -Be 11
            (Get-EnrollmentTokenState -ExpiresAt '2026-09-01T00:00:00Z' -Now $script:now).state | Should -Be 'expired'
            (Get-EnrollmentTokenState -ExpiresAt $null -Now $script:now).state | Should -Be 'unknown'
        }
    }

    Context 'List' {
        It 'returns Apple and Android profiles and every token with expiry for alerting' {
            $res = Get-EnrollmentProfiles -TenantId 't' -Now $script:now
            @($res.profiles.id) | Should -Be @('ios-1', 'and-1', 'and-2')
            $res.profiles[0].depOnboardingSettingId | Should -Be 'dep-1'
            $res.profiles[0].profileType | Should -Be 'depIOSEnrollmentProfile'
            $apple = $res.tokens | Where-Object platform -eq 'apple-ade'
            $apple.appleId | Should -Be 'mdm@contoso.com'
            $apple.state | Should -Be 'expiring'
            $apple.daysRemaining | Should -Be 11
            ($res.tokens | Where-Object id -eq 'and-1').state | Should -Be 'expired'
            ($res.tokens | Where-Object id -eq 'and-2').state | Should -Be 'ok'
        }

        It 'never returns Android enrollment secrets' {
            $res = Get-EnrollmentProfiles -TenantId 't' -Now $script:now
            ($res | ConvertTo-Json -Depth 10) | Should -Not -Match 'SECRET'
        }
    }

    Context 'Writes' {
        It 'previews a create without writing and strips read-only and secret fields' {
            $body = @{ displayName = 'New'; enrollmentMode = 'corporateOwnedWorkProfile'; id = 'x'; tokenValue = 'SECRET-TOKEN' }
            $res = Invoke-EnrollmentProfileWrite -TenantId 't' -Action create -Platform android-enterprise -ProfileBody $body -Preview
            $res.preview | Should -BeTrue
            $res.plan.after.Keys | Sort-Object | Should -Be @('@odata.type', 'displayName', 'enrollmentMode')
            @($script:graph | Where-Object Method -ne 'GET').Count | Should -Be 0
        }

        It 'creates an Android profile and audits it without the token' {
            $res = Invoke-EnrollmentProfileWrite -TenantId 't' -Action create -Platform android-enterprise -ProfileBody @{ displayName = 'New'; enrollmentMode = 'corporateOwnedFullyManaged' } -Actor 'op' -Confirm:$false
            $res.profileId | Should -Be 'and-9'
            $post = $script:graph | Where-Object Method -eq 'POST'
            ($post.Body | ConvertFrom-Json).'@odata.type' | Should -Be '#microsoft.graph.androidDeviceOwnerEnrollmentProfile'
            $res.auditEvent.action | Should -Be 'intune.enrollment-profile.create'
            $res.auditEvent.actor | Should -Be 'op'
            $res.auditEvent.before | Should -BeNullOrEmpty
            ($res | ConvertTo-Json -Depth 10) | Should -Not -Match 'SECRET'
        }

        It 'updates an Apple profile under its ADE token with before/after' {
            $res = Invoke-EnrollmentProfileWrite -TenantId 't' -Action update -Platform apple-ade -DepOnboardingSettingId 'dep-1' -ProfileId 'ios-1' -ProfileBody @{ '@odata.type' = '#microsoft.graph.depIOSEnrollmentProfile'; displayName = 'iPhone v2' } -Confirm:$false
            $patch = $script:graph | Where-Object Method -eq 'PATCH'
            $patch.Uri | Should -Be '/beta/deviceManagement/depOnboardingSettings/dep-1/enrollmentProfiles/ios-1'
            $res.auditEvent.before.displayName | Should -Be 'iPhone standard'
            $res.auditEvent.after.displayName | Should -Be 'iPhone v2'
            $res.auditEvent.after.requiresUserAuthentication | Should -BeTrue
        }

        It 'deletes only with the typed profile name' {
            $noConfirm = Invoke-EnrollmentProfileWrite -TenantId 't' -Action delete -Platform android-enterprise -ProfileId 'and-1' -Confirm:$false
            $noConfirm.error | Should -Be 'enrollment-profile.confirmation_required'
            ($noConfirm | ConvertTo-Json -Depth 10) | Should -Not -Match 'SECRET'
            @($script:graph | Where-Object Method -eq 'DELETE').Count | Should -Be 0
            $res = Invoke-EnrollmentProfileWrite -TenantId 't' -Action delete -Platform android-enterprise -ProfileId 'and-1' -ConfirmName 'Kiosk' -Confirm:$false
            $res.auditEvent.action | Should -Be 'intune.enrollment-profile.delete'
            $res.auditEvent.after | Should -BeNullOrEmpty
            ($script:graph | Where-Object Method -eq 'DELETE').Uri | Should -Be '/beta/deviceManagement/androidDeviceOwnerEnrollmentProfiles/and-1'
        }

        It 'assigns an Apple profile to device serials' {
            $res = Invoke-EnrollmentProfileWrite -TenantId 't' -Action assign -Platform apple-ade -DepOnboardingSettingId 'dep-1' -ProfileId 'ios-1' -SerialNumbers @('C02X1', 'C02X2') -Confirm:$false
            $post = $script:graph | Where-Object Method -eq 'POST'
            $post.Uri | Should -BeLike '*/enrollmentProfiles/ios-1/updateDeviceProfileAssignment'
            @(($post.Body | ConvertFrom-Json).deviceIds) | Should -Be @('C02X1', 'C02X2')
            @($res.auditEvent.after.assignedSerialNumbers) | Should -Be @('C02X1', 'C02X2')
        }

        It 'rejects Android assignment, a missing ADE token id, and a missing profile' {
            (Invoke-EnrollmentProfileWrite -TenantId 't' -Action assign -Platform android-enterprise -ProfileId 'and-1' -SerialNumbers 'x' -Preview).statusCode | Should -Be 400
            (Invoke-EnrollmentProfileWrite -TenantId 't' -Action create -Platform apple-ade -ProfileBody @{ displayName = 'x' } -Preview).message | Should -BeLike '*depOnboardingSettingId*'
            (Invoke-EnrollmentProfileWrite -TenantId 't' -Action update -Platform android-enterprise -ProfileId 'gone' -ProfileBody @{ displayName = 'x' } -Preview).statusCode | Should -Be 404
        }
    }

    Context 'Entrypoint' {
        It 'lists through the job document' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest { @{ value = @() } }
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; action = 'list' } | ConvertTo-Json | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.tenantId | Should -Be 't'
        }

        It 'rejects an unknown platform for a write' {
            $path = Join-Path $TestDrive 'bad.json'
            @{ tenantId = 't'; action = 'create'; platform = 'windows' } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-EnrollmentProfileJob -Path $path } | Should -Throw '*unknown platform*'
        }
    }
}
