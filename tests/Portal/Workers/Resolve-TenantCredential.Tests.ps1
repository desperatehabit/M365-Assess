BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:resolver = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Resolve-TenantCredential.ps1'
    $script:workerModule = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/M365Portal.Workers.psm1'
    $script:workerManifest = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/M365Portal.Workers.psd1'
    $script:stubTenantId = '00000000-0000-0000-0000-000000000001'
    $script:sentinelSecret = 'SENTINEL-SECRET-9f8b7a6c5d4e'
    $script:sentinelRef = 'ref://store/sentinel-credential'

    . (Join-Path -Path $script:repoRoot -ChildPath 'src/M365-Assess/Common/RunContext.ps1')
    . $script:resolver

    Import-Module -Name $script:workerManifest -Force

    $script:scratchRoots = @()

    function script:New-CredentialScratch {
        $root = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("m365-cred-test-{0}" -f [guid]::NewGuid().ToString('N'))
        New-Item -Path $root -ItemType Directory -Force | Out-Null
        $script:scratchRoots += $root
        return $root
    }

    function script:New-ThumbprintRecord {
        return @{
            tenantId   = $script:stubTenantId
            authMethod = 'certificate-thumbprint'
            clientId   = '00000000-0000-0000-0000-000000000002'
            secretRef  = ''
            thumbprint = 'AA11BB22CC33DD44EE55FF660011223344556677'
            environment = 'commercial'
        }
    }

    function script:New-SecretRecord {
        return @{
            tenantId   = $script:stubTenantId
            authMethod = 'client-secret'
            clientId   = '00000000-0000-0000-0000-000000000002'
            secretRef  = $script:sentinelRef
            thumbprint = $null
            environment = 'commercial'
        }
    }

    function script:New-SecretStore {
        param(
            [hashtable]$Seen
        )
        $secret = $script:sentinelSecret
        return {
            param([string]$SecretRef)
            $Seen['ref'] = $SecretRef
            return $secret
        }.GetNewClosure()
    }
}

AfterAll {
    Remove-Module -Name 'M365Portal.Workers' -ErrorAction SilentlyContinue
    foreach ($root in $script:scratchRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Resolve-TenantCredential worker (T-0011)' {

    Context 'the worker files' {
        It 'ships the resolver alongside the worker module' {
            Test-Path -LiteralPath $script:resolver | Should -BeTrue
            Test-Path -LiteralPath $script:workerModule | Should -BeTrue
        }

        It 'loads the resolver from the worker module' {
            $source = Get-Content -LiteralPath $script:workerModule -Raw
            $source | Should -Match 'Resolve-TenantCredential\.ps1'
            $source | Should -Match "'Resolve-TenantCredential'"
            $source | Should -Match "'Protect-WorkerSecret'"
        }

        It 'exposes the resolver inside the loaded module session' {
            $module = Get-Module -Name 'M365Portal.Workers'
            $module | Should -Not -BeNullOrEmpty
            $names = & $module { (Get-Command -Name 'Resolve-TenantCredential', 'Protect-WorkerSecret' -CommandType Function).Name }
            $names | Should -Contain 'Resolve-TenantCredential'
            $names | Should -Contain 'Protect-WorkerSecret'
        }

        It 'never persists secret material from the resolver' {
            $source = Get-Content -LiteralPath $script:resolver -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
            $source | Should -Not -Match 'Invoke-Expression'
        }
    }

    Context 'child-side resolution' {
        It 'resolves a certificate-thumbprint credential without touching the store' {
            $record = New-ThumbprintRecord
            $auth = Resolve-TenantCredential -TenantId $script:stubTenantId `
                -CredentialRef "tenants/$script:stubTenantId/credential" `
                -CredentialRecord $record -Sections @('Identity')

            $auth['Method'] | Should -Be 'Certificate'
            $auth['ClientId'] | Should -Be $record['clientId']
            $auth['CertificateThumbprint'] | Should -Be $record['thumbprint']
            $auth['M365Environment'] | Should -Be 'commercial'
            $auth.ContainsKey('ClientSecret') | Should -BeFalse
        }

        It 'resolves a client secret from the store by secretRef as a SecureString' {
            $seen = @{}
            $auth = Resolve-TenantCredential -TenantId $script:stubTenantId `
                -CredentialRef "tenants/$script:stubTenantId/credential" `
                -CredentialRecord (New-SecretRecord) -CredentialStore (New-SecretStore -Seen $seen) `
                -Sections @('Identity')

            $seen['ref'] | Should -Be $script:sentinelRef
            $auth['Method'] | Should -Be 'ClientSecret'
            $auth['ClientId'] | Should -Be '00000000-0000-0000-0000-000000000002'
            $auth['ClientSecret'] | Should -BeOfType [securestring]
        }

        It 'applies resolved material to a RunContext the assessment can connect with' {
            $seen = @{}
            $auth = Resolve-TenantCredential -TenantId $script:stubTenantId `
                -CredentialRef "tenants/$script:stubTenantId/credential" `
                -CredentialRecord (New-SecretRecord) -CredentialStore (New-SecretStore -Seen $seen) `
                -Sections @('Identity')

            $scratch = New-CredentialScratch
            $ctx = New-RunContext -TenantId $script:stubTenantId -Sections @('Identity') -Auth $auth `
                -Timestamp '20260101_000000' -OutputFolder (Join-Path -Path $scratch -ChildPath 'assessment')
            $ctx.Auth.ClientId | Should -Be '00000000-0000-0000-0000-000000000002'
            $ctx.Auth.ClientSecret | Should -BeOfType [securestring]

            $probe = Join-Path -Path $scratch -ChildPath 'probe.ps1'
            @'
param(
    [string]$OutputFolder = '',
    [string]$ClientId = '',
    [Parameter(ValueFromRemainingArguments = $true)]
    $Remaining
)
$ErrorActionPreference = 'Stop'
[ordered]@{ ClientId = $ClientId } | ConvertTo-Json | Set-Content -Path (Join-Path -Path $OutputFolder -ChildPath 'probe.json') -Encoding UTF8
'@ | Set-Content -Path $probe -Encoding UTF8
            $output = Join-Path -Path $scratch -ChildPath 'tenant'
            New-Item -Path $output -ItemType Directory -Force | Out-Null
            Invoke-WorkerAssessment -Context $ctx -OutputFolder $output -AssessmentScript $probe
            $seenAuth = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'probe.json') -Raw | ConvertFrom-Json -AsHashtable
            $seenAuth['ClientId'] | Should -Be '00000000-0000-0000-0000-000000000002'
        }

        It 'keeps secret material out of context.json and the result envelope' {
            $seen = @{}
            $auth = Resolve-TenantCredential -TenantId $script:stubTenantId `
                -CredentialRef "tenants/$script:stubTenantId/credential" `
                -CredentialRecord (New-SecretRecord) -CredentialStore (New-SecretStore -Seen $seen) `
                -Sections @('Identity')

            $scratch = New-CredentialScratch
            $ctx = New-RunContext -TenantId $script:stubTenantId -Sections @('Identity') -Auth $auth `
                -Timestamp '20260101_000000' -OutputFolder (Join-Path -Path $scratch -ChildPath 'assessment')
            $contextFile = Join-Path -Path $scratch -ChildPath 'context.json'
            ConvertTo-RunContextJson -Context $ctx | Set-Content -Path $contextFile -Encoding UTF8
            Get-Content -LiteralPath $contextFile -Raw | Should -Not -Match ([regex]::Escape($script:sentinelSecret))

            $output = Join-Path -Path $scratch -ChildPath 'tenant'
            $resultPath = Write-WorkerResult -OutputFolder $output -JobId 'job-cred-1' -TenantId $script:stubTenantId `
                -RunId 'run-cred-1' -RequestId 'req-cred-1' -CorrelationId 'corr-cred-1' `
                -Status 'succeeded' -ExitCode 0 -ArtifactRefs @() `
                -StartedAt '2026-01-01T00:00:00.000Z' -FinishedAt '2026-01-01T00:05:00.000Z'
            Get-Content -LiteralPath $resultPath -Raw | Should -Not -Match ([regex]::Escape($script:sentinelSecret))
        }
    }

    Context 'unsupported credential combinations' {
        It 'rejects a client secret for Exchange Online sections with a clear, non-secret error' {
            $seen = @{}
            $errorMessage = ''
            try {
                Resolve-TenantCredential -TenantId $script:stubTenantId `
                    -CredentialRef "tenants/$script:stubTenantId/credential" `
                    -CredentialRecord (New-SecretRecord) -CredentialStore (New-SecretStore -Seen $seen) `
                    -Sections @('Email') | Out-Null
            }
            catch {
                $errorMessage = $_.Exception.Message
            }

            $errorMessage | Should -Match 'worker\.credential_unsupported'
            $errorMessage | Should -Match 'certificate'
            $errorMessage | Should -Match 'Email'
            $errorMessage | Should -Not -Match ([regex]::Escape($script:sentinelSecret))
            $seen.ContainsKey('ref') | Should -BeFalse
        }

        It 'rejects a client secret for Purview sections with a clear, non-secret error' {
            $seen = @{}
            $errorMessage = ''
            try {
                Resolve-TenantCredential -TenantId $script:stubTenantId `
                    -CredentialRef "tenants/$script:stubTenantId/credential" `
                    -CredentialRecord (New-SecretRecord) -CredentialStore (New-SecretStore -Seen $seen) `
                    -Sections @('SOC2') | Out-Null
            }
            catch {
                $errorMessage = $_.Exception.Message
            }

            $errorMessage | Should -Match 'worker\.credential_unsupported'
            $errorMessage | Should -Not -Match ([regex]::Escape($script:sentinelSecret))
        }

        It 'allows a client secret for Graph-only sections' {
            $seen = @{}
            $auth = Resolve-TenantCredential -TenantId $script:stubTenantId `
                -CredentialRef "tenants/$script:stubTenantId/credential" `
                -CredentialRecord (New-SecretRecord) -CredentialStore (New-SecretStore -Seen $seen) `
                -Sections @('Identity', 'Tenant')
            $auth['Method'] | Should -Be 'ClientSecret'
        }

        It 'allows certificate auth for Exchange Online sections without store access' {
            $auth = Resolve-TenantCredential -TenantId $script:stubTenantId `
                -CredentialRef "tenants/$script:stubTenantId/credential" `
                -CredentialRecord (New-ThumbprintRecord) -Sections @('Email', 'Security')
            $auth['Method'] | Should -Be 'Certificate'
        }
    }

    Context 'reference integrity' {
        It 'rejects a credential row belonging to another tenant' {
            $record = New-SecretRecord
            $record['tenantId'] = '00000000-0000-0000-0000-000000000099'
            $errorMessage = ''
            try {
                Resolve-TenantCredential -TenantId $script:stubTenantId `
                    -CredentialRef "tenants/$script:stubTenantId/credential" `
                    -CredentialRecord $record -Sections @('Identity') | Out-Null
            }
            catch {
                $errorMessage = $_.Exception.Message
            }
            $errorMessage | Should -Match 'worker\.credential_ref_mismatch'
            $errorMessage | Should -Not -Match ([regex]::Escape($script:sentinelSecret))
        }

        It 'fails when the store holds no material for the reference' {
            $emptyStore = { param([string]$SecretRef) return $null }.GetNewClosure()
            $errorMessage = ''
            try {
                Resolve-TenantCredential -TenantId $script:stubTenantId `
                    -CredentialRef "tenants/$script:stubTenantId/credential" `
                    -CredentialRecord (New-SecretRecord) -CredentialStore $emptyStore `
                    -Sections @('Identity') | Out-Null
            }
            catch {
                $errorMessage = $_.Exception.Message
            }
            $errorMessage | Should -Match 'worker\.credential_not_found'
            $errorMessage | Should -Not -Match ([regex]::Escape($script:sentinelSecret))
        }

        It 'fails when secret material is needed but no store was provided' {
            $errorMessage = ''
            try {
                Resolve-TenantCredential -TenantId $script:stubTenantId `
                    -CredentialRef "tenants/$script:stubTenantId/credential" `
                    -CredentialRecord (New-SecretRecord) -Sections @('Identity') | Out-Null
            }
            catch {
                $errorMessage = $_.Exception.Message
            }
            $errorMessage | Should -Match 'worker\.credential_store_required'
        }

        It 'rejects an unknown auth method without leaking anything' {
            $record = New-SecretRecord
            $record['authMethod'] = 'frobnicator'
            $errorMessage = ''
            try {
                Resolve-TenantCredential -TenantId $script:stubTenantId `
                    -CredentialRef "tenants/$script:stubTenantId/credential" `
                    -CredentialRecord $record -Sections @('Identity') | Out-Null
            }
            catch {
                $errorMessage = $_.Exception.Message
            }
            $errorMessage | Should -Match 'worker\.credential_invalid'
            $errorMessage | Should -Not -Match ([regex]::Escape($script:sentinelSecret))
        }
    }

    Context 'log redaction' {
        It 'redacts known secret values and leaves references intact' {
            $message = "connecting with tenants/$script:stubTenantId/credential using $script:sentinelSecret failed"
            $redacted = Protect-WorkerSecret -Message $message -Secrets @($script:sentinelSecret)
            $redacted | Should -Not -Match ([regex]::Escape($script:sentinelSecret))
            $redacted | Should -Match '\[REDACTED\]'
            $redacted | Should -Match ([regex]::Escape("tenants/$script:stubTenantId/credential"))
        }

        It 'redacts SecureString secrets and ignores nulls and empties' {
            $secure = ConvertTo-SecureString -String $script:sentinelSecret -AsPlainText -Force
            $redacted = Protect-WorkerSecret -Message "value: $script:sentinelSecret" -Secrets @($secure, $null, '')
            $redacted | Should -Be 'value: [REDACTED]'
        }
    }
}
