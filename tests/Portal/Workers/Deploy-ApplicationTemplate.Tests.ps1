BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Deploy-ApplicationTemplate.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/deploy-application-template.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:config = @{
        appType              = 'win32'
        displayName          = '%AppName% (%Ring%)'
        publisher            = 'Igor Pavlov'
        packageId            = '%SevenZipPackage%'
        installCommandLine   = '7z.exe /S'
        uninstallCommandLine = 'uninstall.exe /S'
        detectionRules       = @(@{ type = 'file'; path = 'C:\Program Files\7-Zip'; fileOrFolderName = '7z.exe' })
    }
    $script:values = @{ AppName = '7-Zip'; Ring = 'Pilot'; SevenZipPackage = 'pkg-42' }
}

Describe 'Deploy-ApplicationTemplate worker (T-0327)' {
    BeforeEach {
        $script:calls = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            $script:calls.Add(@{ Method = $Method; Uri = $Uri })
            @{ value = @() }
        }
    }

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            Get-Command Invoke-ApplicationTemplatePreflight -CommandType Function | Should -Not -BeNullOrEmpty
        }

        It 'issues no write verbs to Graph' {
            (Get-Content -LiteralPath $script:worker -Raw) | Should -Not -Match '-Method\s+(POST|PATCH|PUT|DELETE)'
        }
    }

    Context 'Variable substitution' {
        It 'replaces tokens in every string, including nested ones' {
            $res = Invoke-ApplicationTemplatePreflight -TenantId 't' -Config $script:config -Values $script:values
            $res.request.displayName | Should -Be '7-Zip (Pilot)'
            $res.request.packageId | Should -Be 'pkg-42'
            $res.request.detectionRules[0].fileOrFolderName | Should -Be '7z.exe'
            $res.issues.Count | Should -Be 0
        }

        It 'keeps an unknown token and reports it instead of substituting an empty string' {
            $res = Invoke-ApplicationTemplatePreflight -TenantId 't' -Config $script:config -Values @{ AppName = '7-Zip' }
            $res.request.packageId | Should -Be '%SevenZipPackage%'
            @($res.issues) | Should -Be @("unknown tenant variable '%Ring%'", "unknown tenant variable '%SevenZipPackage%'")
            $script:calls.Count | Should -Be 0
        }

        It 'leaves the template config untouched' {
            $null = Invoke-ApplicationTemplatePreflight -TenantId 't' -Config $script:config -Values $script:values
            $script:config.displayName | Should -Be '%AppName% (%Ring%)'
        }

        It 'passes non-string values through' {
            $res = Invoke-ApplicationTemplatePreflight -TenantId 't' -Config @{ displayName = 'X'; flag = $true; count = 3; nothing = $null } -Values @{}
            $res.request.flag | Should -BeTrue
            $res.request.count | Should -Be 3
            $res.request.nothing | Should -BeNullOrEmpty
        }
    }

    Context 'Existing-app check' {
        It 'looks the resolved name up with an escaped filter and reports no conflict when absent' {
            $res = Invoke-ApplicationTemplatePreflight -TenantId 't' -Config @{ displayName = "O'Brien Tools" } -Values @{}
            $res.conflict | Should -BeFalse
            $script:calls[0].Method | Should -Be 'GET'
            [uri]::UnescapeDataString($script:calls[0].Uri) | Should -BeLike "*displayName eq 'O''Brien Tools'*"
        }

        It 'reports an existing app of the same name as a conflict' {
            Mock Invoke-MgGraphRequest { @{ value = @(@{ id = 'app-7'; displayName = '7-Zip (Pilot)' }) } }
            $res = Invoke-ApplicationTemplatePreflight -TenantId 't' -Config $script:config -Values $script:values
            $res.conflict | Should -BeTrue
            $res.existingAppId | Should -Be 'app-7'
        }

        It 'flags a template without a display name' {
            $res = Invoke-ApplicationTemplatePreflight -TenantId 't' -Config @{ publisher = 'x' } -Values @{}
            $res.issues | Should -Contain 'the template has no displayName'
        }
    }

    Context 'Entrypoint' {
        It 'reads the job and prints the preflight as JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            # The entrypoint has its own script scope, so it cannot see the shared call log.
            Mock Invoke-MgGraphRequest { @{ value = @() } }
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; config = $script:config; values = $script:values } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.request.displayName | Should -Be '7-Zip (Pilot)'
            $out.conflict | Should -BeFalse
        }

        It 'requires a config in the job' {
            $path = Join-Path $TestDrive 'bad.json'
            @{ tenantId = 't' } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-ApplicationTemplateJob -Path $path } | Should -Throw "*missing mandatory 'config'*"
        }
    }
}
