BeforeDiscovery {
    # Nothing needed at discovery time
}

Describe 'Connect-RequiredService' {
    BeforeAll {
        # Stub external commands
        function Get-MgContext { }
        function Get-MgOrganization { }
        function Disconnect-ExchangeOnline { }
        function Update-ProgressStatus { }
        function Test-GraphPermissions { }

        # Load helpers first (provides Write-AssessmentLog, Get-RecommendedAction)
        . "$PSScriptRoot/../../src/M365-Assess/Common/RunContext.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/Connect-RequiredService.ps1"

        Mock Write-Host { }
        Mock Write-AssessmentLog { }
    }

    Context 'when a service is already connected' {
        BeforeAll {
            $connectedServices = [System.Collections.Generic.List[string]]::new()
            $connectedServices.Add('Graph')
            $failedServices = [System.Collections.Generic.List[string]]::new()
            $connectServicePath = 'fake-connect.ps1'
        }

        It 'should skip without displaying a connection message' {
            Connect-RequiredService -Services @('Graph') -SectionName 'Identity'
            # If it skipped, Write-Host should not be called (no "Connecting to..." message)
            Should -Invoke Write-Host -Times 0
        }
    }

    Context 'when a service previously failed' {
        BeforeAll {
            $connectedServices = [System.Collections.Generic.List[string]]::new()
            $failedServices = [System.Collections.Generic.List[string]]::new()
            $failedServices.Add('ExchangeOnline')
            $connectServicePath = 'fake-connect.ps1'
        }

        It 'should skip without retrying' {
            Connect-RequiredService -Services @('ExchangeOnline') -SectionName 'Email'
            Should -Invoke Write-Host -Times 0
        }
    }

    Context 'when connecting a new service successfully' {
        BeforeAll {
            $connectedServices = [System.Collections.Generic.List[string]]::new()
            $failedServices = [System.Collections.Generic.List[string]]::new()
            $issues = [System.Collections.Generic.List[object]]::new()
            $connectServicePath = Join-Path $TestDrive 'mock-connect.ps1'
            Set-Content -Path $connectServicePath -Value '# no-op'
            $M365Environment = 'commercial'
            $graphScopes = @('User.Read.All')
            $script:graphPermissionsChecked = $false
            $Section = @('Identity')
            $sectionScopeMap = @{ 'Identity' = @('User.Read.All') }

            Mock Test-GraphPermissions { }
            Mock Get-MgOrganization {
                return [PSCustomObject]@{
                    Id              = 'test-id'
                    DisplayName     = 'Contoso'
                    VerifiedDomains = @(
                        [PSCustomObject]@{ Name = 'contoso.onmicrosoft.com'; IsInitial = $true }
                    )
                }
            }
        }

        It 'should add the service to connectedServices' {
            Connect-RequiredService -Services @('Graph') -SectionName 'Identity'
            $connectedServices | Should -Contain 'Graph'
        }

        It 'should display friendly service name' {
            $connectedServices.Clear()
            $script:graphPermissionsChecked = $false
            Connect-RequiredService -Services @('Graph') -SectionName 'Identity'
            Should -Invoke Write-Host -ParameterFilter {
                $Object -like '*Microsoft Graph*'
            }
        }
    }

    Context 'when connection throws an error' {
        BeforeAll {
            $connectedServices = [System.Collections.Generic.List[string]]::new()
            $failedServices = [System.Collections.Generic.List[string]]::new()
            $issues = [System.Collections.Generic.List[object]]::new()
            $connectServicePath = Join-Path $TestDrive 'fail-connect.ps1'
            Set-Content -Path $connectServicePath -Value 'throw "Connection refused"'
            $M365Environment = 'commercial'
        }

        It 'should add the service to failedServices' {
            Connect-RequiredService -Services @('ExchangeOnline') -SectionName 'Email'
            $failedServices | Should -Contain 'ExchangeOnline'
        }

        It 'should record an issue' {
            $issues.Count | Should -BeGreaterThan 0
            $issues[0].Severity | Should -Be 'ERROR'
        }
    }

    Context 'when EXO and Purview conflict' {
        BeforeAll {
            $connectedServices = [System.Collections.Generic.List[string]]::new()
            $connectedServices.Add('Purview')
            $failedServices = [System.Collections.Generic.List[string]]::new()
            $issues = [System.Collections.Generic.List[object]]::new()
            $connectServicePath = Join-Path $TestDrive 'mock-connect.ps1'
            Set-Content -Path $connectServicePath -Value '# no-op'
            $M365Environment = 'commercial'

            Mock Disconnect-ExchangeOnline { }
        }

        It 'should disconnect Purview before connecting ExchangeOnline' {
            Connect-RequiredService -Services @('ExchangeOnline') -SectionName 'Email'
            Should -Invoke Disconnect-ExchangeOnline -Times 1
        }

        It 'should remove Purview from connectedServices' {
            $connectedServices | Should -Not -Contain 'Purview'
        }
    }

    Context 'service display name mapping' {
        BeforeAll {
            $connectedServices = [System.Collections.Generic.List[string]]::new()
            $failedServices = [System.Collections.Generic.List[string]]::new()
            $issues = [System.Collections.Generic.List[object]]::new()
            $connectServicePath = Join-Path $TestDrive 'mock-connect.ps1'
            Set-Content -Path $connectServicePath -Value '# no-op'
            $M365Environment = 'commercial'
        }

        It 'should display "Exchange Online" for ExchangeOnline service' -ForEach @(
            @{ Service = 'ExchangeOnline'; Expected = 'Exchange Online' }
            @{ Service = 'Purview'; Expected = 'Purview' }
        ) {
            $connectedServices.Clear()
            $failedServices.Clear()
            Connect-RequiredService -Services @($Service) -SectionName 'Test'
            Should -Invoke Write-Host -ParameterFilter {
                $Object -like "*$Expected*"
            }
        }
    }
}

Describe 'Connect-RequiredService -Context (T-0002)' {
    BeforeAll {
        function Disconnect-ExchangeOnline { }
        function Update-ProgressStatus { }
        function Test-GraphPermissions { }
        function Get-MgOrganization { }

        . "$PSScriptRoot/../../src/M365-Assess/Common/RunContext.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/Connect-RequiredService.ps1"

        Mock Write-Host { }
        Mock Write-AssessmentLog { }
        Mock Test-GraphPermissions { }
        Mock Get-MgOrganization {
            return [PSCustomObject]@{
                Id              = '11111111-1111-1111-1111-111111111111'
                DisplayName     = 'Resolved Tenant'
                VerifiedDomains = @(
                    [PSCustomObject]@{ Name = 'contoso.onmicrosoft.com'; IsInitial = $true }
                )
            }
        }

        $script:capturePath = Join-Path $TestDrive 'connect-capture.json'
        $script:mockConnectPath = Join-Path $TestDrive 'mock-connect.ps1'
        $mockBody = @'
param($Service, $TenantId, $ClientId, $Scopes, $M365Environment)
[PSCustomObject]@{
    Service         = $Service
    TenantId        = $TenantId
    ClientId        = $ClientId
    Scopes          = $Scopes
    M365Environment = $M365Environment
} | ConvertTo-Json | Set-Content -LiteralPath '__CAPTURE__'
'@
        Set-Content -Path $script:mockConnectPath -Value $mockBody.Replace('__CAPTURE__', $script:capturePath)
    }

    It 'threads tenant, auth, scope, and service state from the context' {
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' `
            -Auth @{ ClientId = 'ctx-client'; CertificateThumbprint = 'CTXTHUMB'; M365Environment = 'commercial' } `
            -Sections @('Identity') -GraphScopes @('User.Read.All') `
            -SectionScopeMap @{ Identity = @('User.Read.All') } `
            -OutputFolder (Join-Path $TestDrive 'out') -Timestamp '20260101_120000'
        $ctx.Paths.ProjectRoot = ''
        $ctx.Paths.ConnectServicePath = $script:mockConnectPath

        # Poison the legacy caller scope: -Context must not read any of it.
        $TenantId = 'legacy-should-not-win'
        $ClientId = 'legacy-client'
        $graphScopes = @('Legacy.Read')
        $connectedServices = [System.Collections.Generic.List[string]]::new()
        $connectedServices.Add('PowerBI')

        Connect-RequiredService -Context $ctx -Services @('Graph') -SectionName 'Identity'

        $capture = Get-Content -Path $script:capturePath -Raw | ConvertFrom-Json
        $capture.TenantId | Should -Be 'contoso.onmicrosoft.com'
        $capture.ClientId | Should -Be 'ctx-client'
        $capture.Scopes | Should -Be @('User.Read.All')
        $ctx.Services.Connected | Should -Contain 'Graph'
        $ctx.Services.PermissionsChecked | Should -BeTrue
        $connectedServices | Should -Not -Contain 'Graph'
    }

    It 'works with no legacy caller variables present' {
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -Sections @('Email') `
            -OutputFolder (Join-Path $TestDrive 'out2') -Timestamp '20260101_120001'
        $ctx.Paths.ProjectRoot = ''
        $ctx.Paths.ConnectServicePath = $script:mockConnectPath
        $ctx.Tenant.InitialDomain = 'contoso.onmicrosoft.com'
        $ctx.Services.PermissionsChecked = $true

        { Connect-RequiredService -Context $ctx -Services @('ExchangeOnline') -SectionName 'Email' } | Should -Not -Throw
        $ctx.Services.Connected | Should -Contain 'ExchangeOnline'
    }

    It 'preserves the EXO to Purview mutual exclusion on context service state' {
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -Sections @('Email') `
            -OutputFolder (Join-Path $TestDrive 'out3') -Timestamp '20260101_120002'
        $ctx.Paths.ProjectRoot = ''
        $ctx.Paths.ConnectServicePath = $script:mockConnectPath
        $ctx.Tenant.InitialDomain = 'contoso.onmicrosoft.com'
        $ctx.Services.PermissionsChecked = $true
        [void]$ctx.Services.Connected.Add('ExchangeOnline')

        Mock Disconnect-ExchangeOnline { }

        Connect-RequiredService -Context $ctx -Services @('Purview') -SectionName 'Email'

        Should -Invoke Disconnect-ExchangeOnline -Times 1
        $ctx.Services.Connected | Should -Contain 'Purview'
        $ctx.Services.Connected | Should -Not -Contain 'ExchangeOnline'
    }

    It 'does not fall back to legacy script run state' {
        $script:graphPermissionsChecked = $false
        $script:tenantLicensesResolved = $false
        $script:domainPrefix = 'sentinel'

        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -Sections @('Email') `
            -OutputFolder (Join-Path $TestDrive 'out4') -Timestamp '20260101_120003'
        $ctx.Paths.ProjectRoot = ''
        $ctx.Paths.ConnectServicePath = $script:mockConnectPath
        $ctx.Tenant.InitialDomain = 'contoso.onmicrosoft.com'
        $ctx.Services.PermissionsChecked = $true

        Connect-RequiredService -Context $ctx -Services @('ExchangeOnline') -SectionName 'Email'

        $script:graphPermissionsChecked | Should -BeFalse
        $script:tenantLicensesResolved | Should -BeFalse
        $script:domainPrefix | Should -Be 'sentinel'
        $script:domainPrefix = ''
    }
}

Describe 'Connect-RequiredService legacy shim (T-0002)' {
    BeforeAll {
        function Disconnect-ExchangeOnline { }
        function Update-ProgressStatus { }
        function Test-GraphPermissions { }

        . "$PSScriptRoot/../../src/M365-Assess/Common/RunContext.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/Connect-RequiredService.ps1"

        Mock Write-Host { }
        Mock Write-AssessmentLog { }
        Mock Test-GraphPermissions { }

        $script:capturePath = Join-Path $TestDrive 'legacy-capture.json'
        $script:mockConnectPath = Join-Path $TestDrive 'legacy-connect.ps1'
        $mockBody = @'
param($Service, $TenantId, $ClientId, $Scopes)
[PSCustomObject]@{ Service = $Service; TenantId = $TenantId; ClientId = $ClientId; Scopes = $Scopes } |
    ConvertTo-Json | Set-Content -LiteralPath '__CAPTURE__'
'@
        Set-Content -Path $script:mockConnectPath -Value $mockBody.Replace('__CAPTURE__', $script:capturePath)
    }

    It 'builds a context from legacy variables and reflects state back for callers' {
        Remove-Item -Path $script:capturePath -ErrorAction SilentlyContinue

        $connectedServices = [System.Collections.Generic.List[string]]::new()
        $failedServices = [System.Collections.Generic.List[string]]::new()
        $issues = [System.Collections.Generic.List[object]]::new()
        $M365Environment = 'commercial'
        $TenantId = 'legacy-tenant'
        $ClientId = 'legacy-client'
        $graphScopes = @('User.Read.All')
        $Section = @('Identity')
        $sectionScopeMap = @{ Identity = @('User.Read.All') }
        $connectServicePath = $script:mockConnectPath
        $projectRoot = ''
        $script:graphPermissionsChecked = $false
        $script:tenantLicensesResolved = $true
        $script:resolvedTenantDomain = 'contoso.onmicrosoft.com'

        Connect-RequiredService -Services @('Graph') -SectionName 'Identity'

        $connectedServices | Should -Contain 'Graph'
        $script:graphPermissionsChecked | Should -BeTrue
        $capture = Get-Content -Path $script:capturePath -Raw | ConvertFrom-Json
        $capture.TenantId | Should -Be 'legacy-tenant'
        $capture.ClientId | Should -Be 'legacy-client'
    }
}
