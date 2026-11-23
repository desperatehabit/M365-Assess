BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:workersDir = Join-Path $script:repoRoot 'portal/workers'
    . (Join-Path $script:workersDir 'M365Portal.Workers/Connect-WorkerTenant.ps1')

    function global:Disconnect-MgGraph { param([switch]$ErrorAction) }
    function global:Disconnect-ExchangeOnline { param([switch]$Confirm, $ErrorAction) }
    function global:Disconnect-MicrosoftTeams { param([switch]$Confirm, $ErrorAction) }

    # A stand-in Connect-Service.ps1 that records each call and fails on request.
    $script:connectScript = Join-Path $TestDrive 'Connect-Service.ps1'
    Set-Content -LiteralPath $script:connectScript -Value @'
param(
    [string]$Service, [string]$TenantId, [string]$ClientId, [string]$CertificateThumbprint,
    $Certificate, [string]$CertificatePath, $CertificatePassword, $ClientSecret, [string]$M365Environment
)
$global:ConnectCalls.Add([pscustomobject]@{
    Service = $Service; TenantId = $TenantId; ClientId = $ClientId
    CertificateThumbprint = $CertificateThumbprint; M365Environment = $M365Environment
    HasSecret = ($null -ne $ClientSecret)
})
if ($global:FailService -eq $Service) { throw "connect failed: $global:FailDetail" }
'@

    function New-JobFile {
        param([hashtable]$Job)
        $path = Join-Path $TestDrive ("job-{0}.json" -f [guid]::NewGuid())
        $Job | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path
        return $path
    }

    $script:thumbprintJob = @{
        tenantId   = 'tenant-a'
        credential = @{
            credentialRef = 'tenants/tenant-a/credential'
            record        = @{ tenantId = 'tenant-a'; authMethod = 'certificate'; clientId = 'app-1'; thumbprint = 'ABC123'; environment = 'commercial' }
        }
    }
}

Describe 'Connect-WorkerTenant (T-0826)' {
    BeforeEach {
        $global:ConnectCalls = [System.Collections.Generic.List[object]]::new()
        $global:FailService = ''
        $global:FailDetail = ''
    }

    Context 'credential block' {
        It 'refuses a job without a credential block instead of running unauthenticated' {
            $job = New-JobFile -Job @{ tenantId = 'tenant-a' }
            { Connect-WorkerTenant -JobFile $job -ConnectScript $script:connectScript } | Should -Throw '*worker.credential_missing*'
            $global:ConnectCalls.Count | Should -Be 0
        }

        It 'refuses a job without a tenant id' {
            $job = New-JobFile -Job @{ credential = $script:thumbprintJob.credential }
            { Connect-WorkerTenant -JobFile $job -ConnectScript $script:connectScript } | Should -Throw '*worker.credential_missing*'
        }

        It 'refuses a credential row that belongs to another tenant' {
            $mismatch = @{ tenantId = 'tenant-b'; credential = $script:thumbprintJob.credential }
            { Connect-WorkerTenant -JobFile (New-JobFile -Job $mismatch) -ConnectScript $script:connectScript } |
                Should -Throw '*worker.credential_ref_mismatch*'
        }
    }

    Context 'connecting' {
        It 'connects Graph with the resolved certificate credential' {
            $session = Connect-WorkerTenant -JobFile (New-JobFile -Job $script:thumbprintJob) -ConnectScript $script:connectScript
            @($session.Services) | Should -Be @('Graph')
            $session.TenantId | Should -Be 'tenant-a'
            $global:ConnectCalls[0] | Should -Not -BeNullOrEmpty
            $global:ConnectCalls[0].Service | Should -Be 'Graph'
            $global:ConnectCalls[0].TenantId | Should -Be 'tenant-a'
            $global:ConnectCalls[0].ClientId | Should -Be 'app-1'
            $global:ConnectCalls[0].CertificateThumbprint | Should -Be 'ABC123'
            $global:ConnectCalls[0].M365Environment | Should -Be 'commercial'
        }

        It 'connects a write job with the operator credential block (T-0917)' {
            $operatorJob = @{
                tenantId   = 'tenant-a'
                credential = @{
                    credentialRef = 'tenants/tenant-a/operator-credential'
                    purpose       = 'operator'
                    record        = @{
                        tenantId    = 'tenant-a'
                        authMethod  = 'certificate'
                        clientId    = 'operator-app'
                        thumbprint  = 'OP123'
                        environment = 'commercial'
                        purpose     = 'operator'
                    }
                }
            }
            $session = Connect-WorkerTenant -JobFile (New-JobFile -Job $operatorJob) -ConnectScript $script:connectScript
            @($session.Services) | Should -Be @('Graph')
            $global:ConnectCalls[0].ClientId | Should -Be 'operator-app'
            $global:ConnectCalls[0].CertificateThumbprint | Should -Be 'OP123'
        }

        It 'connects each requested service in order' {
            $session = Connect-WorkerTenant -JobFile (New-JobFile -Job $script:thumbprintJob) -Service Graph, ExchangeOnline -ConnectScript $script:connectScript
            @($global:ConnectCalls | ForEach-Object { $_.Service }) | Should -Be @('Graph', 'ExchangeOnline')
            @($session.Services) | Should -Be @('Graph', 'ExchangeOnline')
        }

        It 'connects Graph before an ExchangeOnline-only worker so the initial domain resolves' {
            $session = Connect-WorkerTenant -JobFile (New-JobFile -Job $script:thumbprintJob) -Service ExchangeOnline -ConnectScript $script:connectScript
            @($global:ConnectCalls | ForEach-Object { $_.Service }) | Should -Be @('Graph', 'ExchangeOnline')
            @($session.Services) | Should -Be @('Graph', 'ExchangeOnline')
        }

        It 'connects Graph before a Purview worker so the initial domain resolves (T-0941)' {
            $session = Connect-WorkerTenant -JobFile (New-JobFile -Job $script:thumbprintJob) -Service Purview -ConnectScript $script:connectScript
            @($global:ConnectCalls | ForEach-Object { $_.Service }) | Should -Be @('Graph', 'Purview')
            @($session.Services) | Should -Be @('Graph', 'Purview')
        }

        It 'opens a MicrosoftTeams session with the resolved app-only certificate (T-0941)' {
            $global:TeamsParams = $null
            $teams = { param($p) $global:TeamsParams = $p; return $true }
            $session = Connect-WorkerTenant -JobFile (New-JobFile -Job $script:thumbprintJob) -Service Teams -TeamsConnect $teams -ConnectScript $script:connectScript
            @($session.Services) | Should -Be @('Teams')
            $global:TeamsParams.ApplicationId | Should -Be 'app-1'
            $global:TeamsParams.TenantId | Should -Be 'tenant-a'
            $global:TeamsParams.CertificateThumbprint | Should -Be 'ABC123'
            $global:ConnectCalls.Count | Should -Be 0
        }

        It 'refuses a MicrosoftTeams session without a certificate (T-0941)' {
            $noCert = @{
                tenantId   = 'tenant-a'
                credential = @{
                    credentialRef = 'tenants/tenant-a/credential'
                    record        = @{ tenantId = 'tenant-a'; authMethod = 'client-secret'; clientId = 'app-1'; secretRef = 'ref://tenant-a/secret' }
                }
            }
            { Connect-WorkerTenant -JobFile (New-JobFile -Job $noCert) -Service Teams -CredentialStore { 'x' } -ConnectScript $script:connectScript } |
                Should -Throw
        }

        It 'disconnects what it already opened when a later service fails' {
            Mock Disconnect-MgGraph { }
            $global:FailService = 'ExchangeOnline'
            { Connect-WorkerTenant -JobFile (New-JobFile -Job $script:thumbprintJob) -Service Graph, ExchangeOnline -ConnectScript $script:connectScript } |
                Should -Throw '*Failed to connect ExchangeOnline*worker.connect_failed*'
            Should -Invoke Disconnect-MgGraph -Times 1
        }

        It 'scrubs secret material from connection errors' {
            $secretJob = @{
                tenantId   = 'tenant-a'
                credential = @{
                    credentialRef = 'ref://tenant-a/secret'
                    record        = @{ tenantId = 'tenant-a'; authMethod = 'client-secret'; clientId = 'app-1'; secretRef = 'ref://tenant-a/secret' }
                }
            }
            $global:FailService = 'Graph'
            $global:FailDetail = 's3cret-value'
            $store = { param($SecretRef) 's3cret-value' }
            $err = $null
            try {
                Connect-WorkerTenant -JobFile (New-JobFile -Job $secretJob) -CredentialStore $store -ConnectScript $script:connectScript
            }
            catch { $err = $_.Exception.Message }
            $err | Should -Match 'worker.connect_failed'
            $err | Should -Not -Match 's3cret-value'
            $global:ConnectCalls[0].HasSecret | Should -BeTrue
        }

        It 'rejects client-secret credentials for Exchange Online before connecting' {
            $secretJob = @{
                tenantId   = 'tenant-a'
                credential = @{
                    credentialRef = 'ref://tenant-a/secret'
                    record        = @{ tenantId = 'tenant-a'; authMethod = 'client-secret'; clientId = 'app-1'; secretRef = 'ref://tenant-a/secret' }
                }
            }
            { Connect-WorkerTenant -JobFile (New-JobFile -Job $secretJob) -Service ExchangeOnline -CredentialStore { 'x' } -ConnectScript $script:connectScript } |
                Should -Throw
            $global:ConnectCalls.Count | Should -Be 0
        }
    }

    Context 'Disconnect-WorkerTenant' {
        It 'is a no-op for a null session' {
            { Disconnect-WorkerTenant -Session $null } | Should -Not -Throw
        }

        It 'disconnects each connected service once' {
            Mock Disconnect-MgGraph { }
            Mock Disconnect-ExchangeOnline { }
            Mock Disconnect-MicrosoftTeams { }
            $teams = { param($p) return $true }
            $session = Connect-WorkerTenant -JobFile (New-JobFile -Job $script:thumbprintJob) -Service Graph, ExchangeOnline, Teams -TeamsConnect $teams -ConnectScript $script:connectScript
            Disconnect-WorkerTenant -Session $session
            Disconnect-WorkerTenant -Session $session
            Should -Invoke Disconnect-MgGraph -Times 1
            Should -Invoke Disconnect-ExchangeOnline -Times 1
            Should -Invoke Disconnect-MicrosoftTeams -Times 1
        }
    }

    Context 'entrypoint convention' {
        It 'every Graph- or Exchange-calling entrypoint connects and disconnects its tenant' {
            $offenders = foreach ($entry in Get-ChildItem -LiteralPath $script:workersDir -Filter '*.ps1') {
                $source = Get-Content -LiteralPath $entry.FullName -Raw
                $workers = [regex]::Matches($source, "M365Portal\.Workers/([A-Za-z-]+)\.ps1") | ForEach-Object { $_.Groups[1].Value } |
                    Where-Object { $_ -ne 'Connect-WorkerTenant' }
                $callsTenant = $false
                foreach ($w in $workers) {
                    $workerSource = Get-Content -LiteralPath (Join-Path $script:workersDir "M365Portal.Workers/$w.ps1") -Raw
                    if ($workerSource -match 'Invoke-MgGraphRequest|Update-Mg[A-Z]|Set-(Mailbox|DistributionGroup|UnifiedGroup)|Get-(Mailbox|InboxRule|UnifiedGroup)') {
                        $callsTenant = $true
                    }
                }
                if ($entry.Name -eq 'get-intune-policies.ps1' -or $entry.Name -eq 'set-intune-policy.ps1') { $callsTenant = $true }
                if ($callsTenant -and ($source -notmatch 'Connect-WorkerTenant -JobFile' -or $source -notmatch 'finally \{\s+Disconnect-WorkerTenant -Session')) {
                    $entry.Name
                }
            }
            @($offenders) | Should -Be @()
        }
    }
}

Describe 'Invoke-WorkerAssessment tenant domain (T-0926)' {
    BeforeAll {
        Import-Module -Name (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/M365Portal.Workers.psd1') -Force
        . (Join-Path $script:repoRoot 'src/M365-Assess/Common/RunContext.ps1')

        $script:probeScript = Join-Path $TestDrive 'assessment-probe.ps1'
        @'
param(
    [string]$OutputFolder = '',
    [string]$TenantId = '',
    [switch]$NonInteractive,
    [Parameter(ValueFromRemainingArguments = $true)]
    $Remaining
)
$ErrorActionPreference = 'Stop'
New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
[ordered]@{ TenantId = $TenantId; NonInteractive = [bool]$NonInteractive } | ConvertTo-Json |
    Set-Content -Path (Join-Path $OutputFolder 'probe.json') -Encoding UTF8
'@ | Set-Content -LiteralPath $script:probeScript -Encoding UTF8

        function script:Invoke-AssessmentProbe {
            param([object]$Context, [string]$Folder)
            $output = Join-Path $TestDrive $Folder
            Invoke-WorkerAssessment -Context $Context -OutputFolder $output -AssessmentScript $script:probeScript
            return Get-Content -LiteralPath (Join-Path $output 'probe.json') -Raw | ConvertFrom-Json
        }
    }

    It 'passes DefaultDomain instead of the tenant GUID' {
        $ctx = New-RunContext -TenantId '00000000-0000-0000-0000-000000000000' `
            -DefaultDomain 'contoso.onmicrosoft.com' -Sections @('Tenant') -Timestamp '20260101_120000'
        $seen = Invoke-AssessmentProbe -Context $ctx -Folder 'probe-default'
        $seen.TenantId | Should -Be 'contoso.onmicrosoft.com'
        $seen.TenantId | Should -Not -Match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
    }

    It 'uses InitialDomain when DefaultDomain is absent' {
        $ctx = New-RunContext -TenantId '00000000-0000-0000-0000-000000000000' `
            -InitialDomain 'contoso.onmicrosoft.com' -Sections @('Tenant') -Timestamp '20260101_120001'
        $seen = Invoke-AssessmentProbe -Context $ctx -Folder 'probe-initial'
        $seen.TenantId | Should -Be 'contoso.onmicrosoft.com'
    }

    It 'keeps the tenant id when no domain is known' {
        $ctx = New-RunContext -TenantId '00000000-0000-0000-0000-000000000000' `
            -Sections @('Tenant') -Timestamp '20260101_120002'
        $seen = Invoke-AssessmentProbe -Context $ctx -Folder 'probe-guid'
        $seen.TenantId | Should -Be '00000000-0000-0000-0000-000000000000'
    }
}


AfterAll {
    Remove-Item -Path 'Function:\Disconnect-MgGraph' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Disconnect-ExchangeOnline' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Disconnect-MicrosoftTeams' -ErrorAction SilentlyContinue
}
