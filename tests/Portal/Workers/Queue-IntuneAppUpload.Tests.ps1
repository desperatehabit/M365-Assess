BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Queue-IntuneAppUpload.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/queue-intune-app-upload.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    Add-Type -AssemblyName System.IO.Compression.FileSystem

    function script:New-IntuneWinFixture {
        param([string]$Path, [string]$Content = 'encrypted-payload')
        $stage = Join-Path $TestDrive "stage-$([guid]::NewGuid())"
        $null = New-Item -ItemType Directory -Path (Join-Path $stage 'IntuneWinPackage/Metadata') -Force
        $null = New-Item -ItemType Directory -Path (Join-Path $stage 'IntuneWinPackage/Contents') -Force
        @'
<ApplicationInfo ToolVersion="1.8.4.0">
  <Name>7-Zip</Name>
  <UnencryptedContentSize>1234</UnencryptedContentSize>
  <FileName>IntunePackage.intunewin</FileName>
  <SetupFile>7z.exe</SetupFile>
  <EncryptionInfo>
    <EncryptionKey>KEY-SECRET</EncryptionKey>
    <MacKey>MAC-KEY</MacKey>
    <InitializationVector>IV</InitializationVector>
    <Mac>MAC</Mac>
    <ProfileIdentifier>ProfileVersion1</ProfileIdentifier>
    <FileDigest>DIGEST</FileDigest>
    <FileDigestAlgorithm>SHA256</FileDigestAlgorithm>
  </EncryptionInfo>
</ApplicationInfo>
'@ | Set-Content -LiteralPath (Join-Path $stage 'IntuneWinPackage/Metadata/Detection.xml')
        Set-Content -LiteralPath (Join-Path $stage 'IntuneWinPackage/Contents/IntunePackage.intunewin') -Value $Content -NoNewline
        [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $Path)
        return $Path
    }

    $script:win32App = @{
        displayName          = '7-Zip'
        publisher            = 'Igor Pavlov'
        installCommandLine   = '7z.exe /S'
        uninstallCommandLine = 'uninstall.exe /S'
        runAsAccount         = 'system'
        detectionRules       = @(@{ type = 'file'; path = 'C:\Program Files\7-Zip'; fileOrFolderName = '7z.exe' })
    }
    $script:sas = 'https://blob.example.net/c/f?sv=2024&sig=SAS-SECRET'
    $script:packageUrl = 'http://127.0.0.1:8080/v1/app-packages/pkg-1?tenant=t&expires=1&sig=URL-SECRET'
}

Describe 'Queue-IntuneAppUpload worker (T-0323)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            Get-Command Invoke-IntuneAppUpload   -CommandType Function | Should -Not -BeNullOrEmpty
            Get-Command Read-IntuneAppUploadJob  -CommandType Function | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Job document reading' {
        It 'requires the mandatory fields' {
            $path = Join-Path $TestDrive 'missing.json'
            @{ tenantId = 't'; appType = 'store'; app = @{ displayName = 'x' } } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-IntuneAppUploadJob -Path $path } | Should -Throw "*missing mandatory 'deploymentId'*"
        }

        It 'requires a package URL for win32 and rejects unsupported types' {
            $path = Join-Path $TestDrive 'win32.json'
            @{ tenantId = 't'; deploymentId = 'd'; appType = 'win32'; app = @{ displayName = 'x' } } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-IntuneAppUploadJob -Path $path } | Should -Throw "*packageUrl*"
            @{ tenantId = 't'; deploymentId = 'd'; appType = 'office'; app = @{ displayName = 'x' } } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-IntuneAppUploadJob -Path $path } | Should -Throw '*unsupported appType*'
        }
    }

    Context 'Detection rules' {
        It 'maps each portal rule type to its Graph win32LobAppRule' {
            (ConvertTo-Win32DetectionRule -Rule @{ type = 'file'; path = 'C:\x'; fileOrFolderName = 'a.exe' }).'@odata.type' | Should -Be '#microsoft.graph.win32LobAppFileSystemRule'
            $reg = ConvertTo-Win32DetectionRule -Rule @{ type = 'registry'; keyPath = 'HKLM\Software\X'; valueName = 'Version'; operationType = 'string'; operator = 'equal'; comparisonValue = '1.0' }
            $reg.ruleType | Should -Be 'detection'
            $reg.operator | Should -Be 'equal'
            (ConvertTo-Win32DetectionRule -Rule @{ type = 'msi'; productCode = '{GUID}' }).productVersionOperator | Should -Be 'notConfigured'
            $script = ConvertTo-Win32DetectionRule -Rule @{ type = 'script'; scriptContent = 'exit 0' }
            [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($script.scriptContent)) | Should -Be 'exit 0'
            { ConvertTo-Win32DetectionRule -Rule @{ type = 'wmi' } } | Should -Throw '*unsupported*'
        }
    }

    Context 'Store app' {
        It 'creates a winGetApp and audits the write' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                $Method | Should -Be 'POST'
                $Uri | Should -Be '/beta/deviceAppManagement/mobileApps'
                $b = $Body | ConvertFrom-Json
                $b.'@odata.type' | Should -Be '#microsoft.graph.winGetApp'
                $b.packageIdentifier | Should -Be '9WZDNCRFJ3PZ'
                $b.installExperience.runAsAccount | Should -Be 'user'
                @{ id = 'app-store' }
            }
            $app = @{ displayName = 'Company Portal'; publisher = 'Microsoft'; packageIdentifier = '9WZDNCRFJ3PZ'; runAsAccount = 'user' }
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType store -App $app -Actor 'op'
            $res.state | Should -Be 'succeeded'
            $res.appId | Should -Be 'app-store'
            @($res.steps.step) | Should -Be @('createApp')
            $res.auditEvents[0].action | Should -Be 'intune.app.create'
            $res.auditEvents[0].actor  | Should -Be 'op'
        }
    }

    Context 'Win32 app' {
        BeforeEach {
            $script:fixture = New-IntuneWinFixture -Path (Join-Path $TestDrive "pkg-$([guid]::NewGuid()).intunewin")
            $script:graph = [System.Collections.Generic.List[object]]::new()
            $script:blocks = [System.Collections.Generic.List[object]]::new()
            $script:fileChecks = 0

            Mock Invoke-WebRequest { param($Uri, $OutFile) Copy-Item -LiteralPath $script:fixture -Destination $OutFile }
            Mock Invoke-RestMethod { param($Method, $Uri, $Body) $script:blocks.Add(@{ Uri = $Uri; Body = $Body }) }
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                $script:graph.Add(@{ Method = $Method; Uri = $Uri; Body = $Body })
                switch -Regex ("$Method $Uri") {
                    '^POST /beta/deviceAppManagement/mobileApps$' { return @{ id = 'app-1' } }
                    '^GET /beta/deviceAppManagement/mobileApps/app-old$' { return @{ id = 'app-old' } }
                    'POST .*/contentVersions$' { return @{ id = '1' } }
                    'POST .*/files$' { return @{ id = 'file-1' } }
                    'GET .*/files/file-1$' {
                        $script:fileChecks++
                        if ($script:fileChecks -eq 1) { return @{ uploadState = 'azureStorageUriRequestPending' } }
                        if ($script:fileChecks -eq 2) { return @{ uploadState = 'azureStorageUriRequestSuccess'; azureStorageUri = $script:sas } }
                        return @{ uploadState = 'commitFileSuccess' }
                    }
                    'POST .*/commit$' { return $null }
                    '^PATCH ' { return $null }
                    default { throw "unexpected Graph call: $Method $Uri" }
                }
            }
        }

        It 'runs the full content-upload sequence and sets the committed version' {
            $params = @{ TenantId = 't'; DeploymentId = 'd-1'; AppType = 'win32'; App = $script:win32App; PackageUrl = $script:packageUrl; PackageSize = (Get-Item $script:fixture).Length; PollDelaySeconds = 0 }
            $res = Invoke-IntuneAppUpload @params
            $res.error | Should -BeNullOrEmpty
            $res.state | Should -Be 'succeeded'
            $res.appId | Should -Be 'app-1'
            $res.contentVersionId | Should -Be '1'
            @($res.steps.step) | Should -Be @('downloadPackage', 'createApp', 'createContentVersion', 'createContentFile', 'uploadContent', 'commitContentFile', 'setCommittedContentVersion')

            $create = ($script:graph[0].Body | ConvertFrom-Json)
            $create.'@odata.type' | Should -Be '#microsoft.graph.win32LobApp'
            $create.fileName | Should -Be 'IntunePackage.intunewin'
            $create.setupFilePath | Should -Be '7z.exe'
            $create.rules[0].ruleType | Should -Be 'detection'

            $fileBody = ($script:graph | Where-Object { $_.Uri -like '*/files' }).Body | ConvertFrom-Json
            $fileBody.size | Should -Be 1234
            $fileBody.sizeEncrypted | Should -Be ([Text.Encoding]::UTF8.GetByteCount('encrypted-payload'))

            $commit = ($script:graph | Where-Object { $_.Uri -like '*/commit' }).Body | ConvertFrom-Json
            $commit.fileEncryptionInfo.encryptionKey | Should -Be 'KEY-SECRET'

            $script:blocks.Count | Should -Be 2
            $script:blocks[0].Uri | Should -BeLike "$script:sas&comp=block&blockid=*"
            $script:blocks[1].Body | Should -BeLike '*<BlockList><Latest>MDAwMA==</Latest></BlockList>'

            $patch = ($script:graph | Where-Object { $_.Method -eq 'PATCH' }).Body | ConvertFrom-Json
            $patch.committedContentVersion | Should -Be '1'
        }

        It 'keeps SAS URIs, the URL signature, and encryption keys out of the result' {
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType win32 -App $script:win32App -PackageUrl $script:packageUrl -PollDelaySeconds 0
            $json = $res | ConvertTo-Json -Depth 20
            $json | Should -Not -Match 'SAS-SECRET|URL-SECRET|KEY-SECRET|MAC-KEY'
            @($res.auditEvents.action) | Should -Be @('intune.app.create', 'intune.app.content.commit')
        }

        It 'reuses the app from a failed attempt on a re-run' {
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType win32 -App $script:win32App -PackageUrl $script:packageUrl -ResumeAppId 'app-old' -PollDelaySeconds 0
            $res.state | Should -Be 'succeeded'
            $res.appId | Should -Be 'app-old'
            $res.steps[1].step | Should -Be 'reuseApp'
            @($script:graph | Where-Object { $_.Method -eq 'POST' -and $_.Uri -eq '/beta/deviceAppManagement/mobileApps' }).Count | Should -Be 0
            $script:graph | Where-Object { $_.Uri -like '*/mobileApps/app-old/microsoft.graph.win32LobApp/contentVersions' } | Should -Not -BeNullOrEmpty
        }

        It 'fails without creating an app when the download does not match its size' {
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType win32 -App $script:win32App -PackageUrl $script:packageUrl -PackageSize 1 -PollDelaySeconds 0
            $res.state | Should -Be 'failed'
            $res.steps[-1].step | Should -Be 'downloadPackage'
            $res.appId | Should -BeNullOrEmpty
            $script:graph.Count | Should -Be 0
        }

        It 'fails on a sha256 mismatch' {
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType win32 -App $script:win32App -PackageUrl $script:packageUrl -PackageSha256 ('0' * 64) -PollDelaySeconds 0
            $res.error | Should -BeLike '*sha256*'
        }

        It 'rejects a file that is not a .intunewin' {
            Set-Content -LiteralPath $script:fixture -Value 'not a zip'
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType win32 -App $script:win32App -PackageUrl $script:packageUrl -PollDelaySeconds 0
            $res.state | Should -Be 'failed'
            $script:graph.Count | Should -Be 0
        }

        It 'reports the failed step with the app id so the item can be re-run, redacting the SAS URI' {
            Mock Invoke-RestMethod { throw "Response status code does not indicate success: 403 for $script:sas&comp=block" }
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType win32 -App $script:win32App -PackageUrl $script:packageUrl -PollDelaySeconds 0
            $res.state | Should -Be 'failed'
            $res.appId | Should -Be 'app-1'
            $res.steps[-1].step | Should -Be 'uploadContent'
            $res.error | Should -BeLike '*https://blob.example.net/c/f?`[redacted`]*'
            $res.error | Should -Not -Match 'SAS-SECRET'
        }

        It 'fails when Graph reports the commit failed' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                switch -Regex ("$Method $Uri") {
                    '^POST /beta/deviceAppManagement/mobileApps$' { return @{ id = 'app-1' } }
                    'POST .*/contentVersions$' { return @{ id = '1' } }
                    'POST .*/files$' { return @{ id = 'file-1' } }
                    'GET .*/files/file-1$' {
                        $script:fileChecks++
                        if ($script:fileChecks -eq 1) { return @{ uploadState = 'azureStorageUriRequestSuccess'; azureStorageUri = $script:sas } }
                        return @{ uploadState = 'commitFileFailed' }
                    }
                    default { return $null }
                }
            }
            $res = Invoke-IntuneAppUpload -TenantId 't' -DeploymentId 'd-1' -AppType win32 -App $script:win32App -PackageUrl $script:packageUrl -PollDelaySeconds 0
            $res.steps[-1].step | Should -Be 'commitContentFile'
            $res.error | Should -BeLike "*commitFileFailed*"
        }
    }

    Context 'Content file polling' {
        It 'gives up after the attempt limit' {
            Mock Invoke-MgGraphRequest { @{ uploadState = 'azureStorageUriRequestPending' } }
            { Wait-IntuneContentFileState -Uri '/x' -Stage azureStorageUriRequest -MaxAttempts 3 -DelaySeconds 0 } | Should -Throw '*after 3 checks*'
            Should -Invoke Invoke-MgGraphRequest -Times 3
        }
    }

    Context 'Entrypoint' {
        It 'reads the job, signs in, and prints the result as JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest { @{ id = 'app-store' } }
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; deploymentId = 'd-9'; appType = 'store'; app = @{ displayName = 'CP'; publisher = 'M'; packageIdentifier = 'X' } } |
                ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.deploymentId | Should -Be 'd-9'
            $out.state | Should -Be 'succeeded'
            Should -Invoke Connect-WorkerTenant -Times 1
            Should -Invoke Disconnect-WorkerTenant -Times 1
        }
    }
}
