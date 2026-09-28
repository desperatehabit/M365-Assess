BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-IntuneApp.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-intune-app.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Queue-IntuneAppUpload.ps1')
    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:script = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('if (Test-Path C:\x) { exit 0 }'))
    function script:New-Win32App {
        @{
            '@odata.type'                  = '#microsoft.graph.win32LobApp'
            id                             = 'app-1'
            displayName                    = '7-Zip'
            description                    = 'Archiver'
            publisher                      = 'Igor Pavlov'
            installCommandLine             = '7z.exe /S'
            uninstallCommandLine           = 'uninstall.exe /S'
            applicableArchitectures        = 'x64,arm64'
            minimumSupportedWindowsRelease = '21H2'
            installExperience              = @{ runAsAccount = 'system'; deviceRestartBehavior = 'suppress' }
            rules                          = @(
                @{ '@odata.type' = '#microsoft.graph.win32LobAppFileSystemRule'; ruleType = 'detection'; path = 'C:\Program Files\7-Zip'; fileOrFolderName = '7z.exe'; operationType = 'exists'; operator = 'notConfigured' }
                @{ '@odata.type' = '#microsoft.graph.win32LobAppPowerShellScriptRule'; ruleType = 'detection'; scriptContent = $script:script }
                @{ '@odata.type' = '#microsoft.graph.win32LobAppRegistryRule'; ruleType = 'requirement'; keyPath = 'HKLM\X' }
            )
            assignments                    = @(@{ id = 'a1' }, @{ id = 'a2' })
        }
    }
}

Describe 'Set-IntuneApp worker (T-0843)' {
    BeforeEach {
        $script:writes = [System.Collections.Generic.List[object]]::new()
        $script:appFixture = New-Win32App
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            if ($Method -ne 'GET') { $script:writes.Add(@{ Method = $Method; Uri = $Uri; Body = $Body }); return $null }
            if ($Uri -like '*/app-1?*') { return $script:appFixture }
            if ($Uri -like '*/store-1?*') { return @{ '@odata.type' = '#microsoft.graph.winGetApp'; id = 'store-1'; displayName = 'Company Portal'; publisher = 'Microsoft'; packageIdentifier = '9WZDNCRFJ3PZ'; installExperience = @{ runAsAccount = 'user' } } }
            if ($Uri -like '*/office-1?*') { return @{ '@odata.type' = '#microsoft.graph.officeSuiteApp'; id = 'office-1'; displayName = 'M365 Apps' } }
            throw 'Response status code does not indicate success: NotFound (Not Found).'
        }
    }

    Context 'Detail' {
        It 'maps a Win32 app into the portal shape, keeping detection rules and dropping requirement rules' {
            $d = Get-IntuneAppDetail -AppId 'app-1'
            $d.appType | Should -Be 'win32'
            $d.installCommandLine | Should -Be '7z.exe /S'
            $d.runAsAccount | Should -Be 'system'
            $d.deviceRestartBehavior | Should -Be 'suppress'
            @($d.applicableArchitectures) | Should -Be @('x64', 'arm64')
            $d.minimumSupportedWindowsRelease | Should -Be '21H2'
            $d.assignmentCount | Should -Be 2
            $d.detectionRules.Count | Should -Be 2
            $d.detectionRules[0].type | Should -Be 'file'
            $d.detectionRules[0].fileOrFolderName | Should -Be '7z.exe'
            $d.detectionRules[1].type | Should -Be 'script'
            $d.detectionRules[1].scriptContent | Should -Be 'if (Test-Path C:\x) { exit 0 }'
        }

        It 'maps a Store app with its package identifier' {
            $d = Get-IntuneAppDetail -AppId 'store-1'
            $d.appType | Should -Be 'store'
            $d.packageIdentifier | Should -Be '9WZDNCRFJ3PZ'
            $d.runAsAccount | Should -Be 'user'
        }

        It 'returns 404 for a missing app and 501 for an unsupported type' {
            (Get-IntuneAppDetail -AppId 'gone').statusCode | Should -Be 404
            (Get-IntuneAppDetail -AppId 'office-1').statusCode | Should -Be 501
        }

        It 'round-trips detection rules through the upload mapping' {
            $d = Get-IntuneAppDetail -AppId 'app-1'
            $graph = ConvertTo-Win32DetectionRule -Rule $d.detectionRules[0]
            $graph.'@odata.type' | Should -Be '#microsoft.graph.win32LobAppFileSystemRule'
            $graph.path | Should -Be 'C:\Program Files\7-Zip'
        }
    }

    Context 'Update' {
        It 'previews the changed fields with before and after, without writing' {
            $res = Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action update -Changes @{ displayName = '7-Zip 24'; installCommandLine = '7z.exe /S' } -Preview
            $res.preview | Should -BeTrue
            @($res.plan.changedFields) | Should -Be @('displayName')
            $res.plan.before.displayName | Should -Be '7-Zip'
            $res.plan.after.displayName | Should -Be '7-Zip 24'
            $script:writes.Count | Should -Be 0
        }

        It 'patches with @odata.type, joins architectures, rebuilds install experience and rules, and audits' {
            $changes = @{
                displayName             = '7-Zip 24'
                applicableArchitectures = @('x64')
                runAsAccount            = 'user'
                detectionRules          = @(@{ type = 'msi'; productCode = '{23170F69-40C1-2702-2400-000001000000}' })
            }
            $res = Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action update -Changes $changes -Actor 'op' -Confirm:$false
            $res.applied | Should -BeTrue
            $patch = $script:writes[0].Body | ConvertFrom-Json
            $script:writes[0].Method | Should -Be 'PATCH'
            $patch.'@odata.type' | Should -Be '#microsoft.graph.win32LobApp'
            $patch.applicableArchitectures | Should -Be 'x64'
            $patch.installExperience.runAsAccount | Should -Be 'user'
            $patch.installExperience.deviceRestartBehavior | Should -Be 'suppress'
            $patch.rules[0].'@odata.type' | Should -Be '#microsoft.graph.win32LobAppProductCodeRule'
            $patch.PSObject.Properties.Name | Should -Not -Contain 'runAsAccount'
            $res.auditEvent.action | Should -Be 'intune.app.update'
            $res.auditEvent.actor | Should -Be 'op'
            $res.auditEvent.before.displayName | Should -Be '7-Zip'
            $res.auditEvent.after.displayName | Should -Be '7-Zip 24'
        }

        It 'refuses fields a Store app does not have and an empty change' {
            (Invoke-IntuneAppChange -TenantId 't' -AppId 'store-1' -Action update -Changes @{ installCommandLine = 'x' } -Preview).message | Should -BeLike '*installCommandLine*store*'
            (Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action update -Changes @{} -Preview).statusCode | Should -Be 400
        }

        It 'writes nothing when the values already match' {
            $res = Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action update -Changes @{ displayName = '7-Zip' } -Confirm:$false
            $res.applied | Should -BeFalse
            $script:writes.Count | Should -Be 0
        }

        It 'audits a failed write' {
            Mock Invoke-MgGraphRequest { param($Method) if ($Method -eq 'GET') { return (New-Win32App) }; throw 'BadRequest: invalid rule' }
            $res = Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action update -Changes @{ displayName = 'x' } -Confirm:$false
            $res.applied | Should -BeFalse
            $res.auditEvent.result | Should -Be 'failure'
            $res.error | Should -BeLike '*invalid rule*'
        }
    }

    Context 'Delete' {
        It 'shows the assignment count and requires the exact name to delete' {
            $preview = Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action delete -Preview
            $preview.plan.assignmentCount | Should -Be 2
            $preview.plan.requiresConfirmation | Should -BeTrue
            (Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action delete -ConfirmName '7-zip' -Confirm:$false).error | Should -Be 'intune.app.confirmation_required'
            $script:writes.Count | Should -Be 0
            $res = Invoke-IntuneAppChange -TenantId 't' -AppId 'app-1' -Action delete -ConfirmName '7-Zip' -Confirm:$false
            $script:writes[0].Method | Should -Be 'DELETE'
            $script:writes[0].Uri | Should -Be '/beta/deviceAppManagement/mobileApps/app-1'
            $res.auditEvent.after | Should -BeNullOrEmpty
        }
    }

    Context 'Entrypoint' {
        It 'reads an app through the job document' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            $fixture = New-Win32App
            Mock Invoke-MgGraphRequest { $fixture }.GetNewClosure()
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; appId = 'app-1'; action = 'get' } | ConvertTo-Json | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.installCommandLine | Should -Be '7z.exe /S'
        }

        It 'rejects an unknown action' {
            $path = Join-Path $TestDrive 'bad.json'
            @{ tenantId = 't'; appId = 'a'; action = 'wipe' } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-IntuneAppJob -Path $path } | Should -Throw '*unknown action*'
        }
    }
}
