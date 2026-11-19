BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-TenantOnboarding.ps1'
    $script:stubTenantId = '00000000-0000-0000-0000-000000000001'

    . $script:worker
}

Describe 'Invoke-TenantOnboarding worker (T-0025)' {

    Context 'the worker script' {
        It 'ships the worker script and function' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command -Name 'Invoke-TenantOnboarding' -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'delegates to Grant-M365AssessConsent rather than reimplementing app registration logic' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Grant-M365AssessConsent'
            # Should not create apps or credentials directly
            $source | Should -Not -Match 'New-MgApplication'
            $source | Should -Not -Match 'New-SelfSignedCertificate'
        }
    }

    Context 'confirmation gating' {
        It 'refuses to run and throws when Confirmed is false' {
            $seenForce = $false
            $handler = {
                param($TenantId, $Force)
                $seenForce = $Force
            }

            {
                Invoke-TenantOnboarding -TenantId $script:stubTenantId `
                                       -Confirmed $false `
                                       -CmdletHandler $handler
            } | Should -Throw '*onboard.confirmation_required*'

            $seenForce | Should -BeFalse
        }

        It 'passes -Force only when Confirmed is true' {
            $passedArgs = @{}
            $handler = {
                param($TenantId, $Force, $AdminUpn, $CreateNew, $AppDisplayName, $ClientId, $CertificateThumbprint)
                $passedArgs['Force'] = $Force
                $passedArgs['TenantId'] = $TenantId
                return [pscustomobject]@{
                    ClientId              = 'app-id-123'
                    CertificateThumbprint = 'THUMB123'
                    AppDisplayName        = 'M365-Assess-Reader'
                    BootstrapCreated      = $true
                    GraphPermissions      = @('User.Read.All')
                    ComplianceRoles       = @('Global Reader')
                    ExoRoleGroups         = @('View-Only Organization Management')
                    TotalFailed           = 0
                }
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId `
                                             -Confirmed $true `
                                             -CmdletHandler $handler

            $passedArgs['Force'] | Should -BeTrue
            $result.status | Should -Be 'succeeded'
            $result.clientId | Should -Be 'app-id-123'
            $result.certificateThumbprint | Should -Be 'THUMB123'
            $result.totalFailed | Should -Be 0
            $result.error | Should -BeNullOrEmpty
        }
    }

    Context 'PFX-backed certificates (no Windows certificate store)' {
        It 'passes the PFX path through so the BFF can store the credential' {
            $handler = {
                param($TenantId, $Force)
                return [pscustomobject]@{
                    ClientId              = 'app-id-pfx'
                    CertificateThumbprint = 'THUMB-PFX'
                    CertificatePath       = '/home/op/.m365-assess/certs/M365-Assess-t.pfx'
                    AppDisplayName        = 'M365-Assess-Reader'
                    BootstrapCreated      = $true
                    TotalFailed           = 0
                }
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId -Confirmed $true -CmdletHandler $handler

            $result.status | Should -Be 'succeeded'
            $result.certificatePath | Should -Be '/home/op/.m365-assess/certs/M365-Assess-t.pfx'
        }

        It 'reports an empty certificatePath when the certificate lives in a store' {
            $handler = {
                param($TenantId, $Force)
                return [pscustomobject]@{ ClientId = 'a'; CertificateThumbprint = 'T'; TotalFailed = 0 }
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId -Confirmed $true -CmdletHandler $handler

            $result.certificatePath | Should -BeNullOrEmpty
        }
    }

    Context 'partial failure detail' {
        It 'names each failed assignment and its error in the message' {
            $handler = {
                param($TenantId, $Force)
                return [pscustomobject]@{
                    ClientId          = 'app-id-partial'
                    GraphPermissions  = @(
                        [pscustomobject]@{ Permission = 'User.Read.All'; Status = 'Added' },
                        [pscustomobject]@{ Permission = 'Purview.ApplicationAccess'; Status = 'NotFound' }
                    )
                    ComplianceRoles   = @([pscustomobject]@{ Role = 'Global Reader'; Status = 'Failed'; Error = "Insufficient`nprivileges" })
                    ExoRoleGroups     = @()
                    TotalFailed       = 2
                }
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId -Confirmed $true -CmdletHandler $handler

            $result.status | Should -Be 'partial'
            $result.error | Should -Match 'Purview\.ApplicationAccess \(NotFound\)'
            $result.error | Should -Match 'Global Reader \(Failed: Insufficient privileges\)'
            $result.error | Should -Not -Match 'User\.Read\.All'
            $result.error | Should -Match 'onboard\.partial_failure'
        }
    }

    Context 'half-provisioned and failed outcomes' {
        It 'returns partial status when TotalFailed is greater than zero' {
            $handler = {
                param($TenantId, $Force)
                return [pscustomobject]@{
                    ClientId              = 'app-id-partial'
                    CertificateThumbprint = 'THUMB-PARTIAL'
                    AppDisplayName        = 'M365-Assess-Reader'
                    BootstrapCreated      = $true
                    GraphPermissions      = @('User.Read.All')
                    ComplianceRoles       = @()
                    ExoRoleGroups         = @()
                    TotalFailed           = 2
                }
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId `
                                             -Confirmed $true `
                                             -CmdletHandler $handler

            $result.status | Should -Be 'partial'
            $result.clientId | Should -Be 'app-id-partial'
            $result.totalFailed | Should -Be 2
            $result.error | Should -Match 'onboard.partial_failure'
        }

        It 'returns failed status with error message when cmdlet throws' {
            $handler = {
                param($TenantId, $Force)
                throw "Insufficient privileges to grant admin consent."
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId `
                                             -Confirmed $true `
                                             -CmdletHandler $handler

            $result.status | Should -Be 'failed'
            $result.totalFailed | Should -Be 1
            $result.error | Should -Match 'Insufficient privileges'
            $result.error | Should -Match 'onboard.failed'
        }
    }
}

Describe 'Onboarding sign-in window (hidden Windows worker)' {
    # Graph SDK 2.34+ always signs in through WAM on Windows, and WAM needs a console window.
    # A worker spawned hidden has none, so the consent runs in a new visible window instead.

    BeforeAll {
        $script:fakeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("onboard-tests-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:fakeDir -Force | Out-Null

        # A stand-in for Grant-M365AssessConsent.ps1 (path with a space, to exercise quoting).
        $script:fakeConsent = Join-Path $script:fakeDir 'fake consent.ps1'
        Set-Content -LiteralPath $script:fakeConsent -Encoding utf8 -Value @'
function Grant-M365AssessConsent {
    [CmdletBinding()]
    param($TenantId, [switch]$Force, [switch]$CreateNew, $AdminUpn, $AppDisplayName, $ClientId, $CertificateThumbprint)
    if ($TenantId -eq 'fail-tenant') { throw 'consent blew up' }
    [pscustomobject]@{
        ClientId              = "client-for-$TenantId"
        CertificateThumbprint = 'THUMB'
        AppDisplayName        = "force=$($Force.IsPresent) createNew=$($CreateNew.IsPresent) upn=$AdminUpn"
        TotalFailed           = 0
        GraphPermissions      = @([pscustomobject]@{ Permission = 'User.Read.All'; Status = 'Granted' })
        ComplianceRoles       = @()
        ExoRoleGroups         = @()
    }
}
'@

        # Runs the real runner through Start-Process, in this console rather than a new window.
        $script:inConsole = {
            param($startParams)
            $startParams.Remove('WindowStyle')
            Start-Process @startParams -NoNewWindow
        }
    }

    AfterAll {
        Remove-Item -LiteralPath $script:fakeDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Context 'Invoke-ConsentInSignInWindow' {
        It 'asks for a normal, waited-on window' {
            {
                Invoke-ConsentInSignInWindow -CmdletScript $script:fakeConsent -ConsentParameters @{ TenantId = 't' } -StartProcess {
                    param($startParams)
                    $script:seenParams = $startParams
                }
            } | Should -Throw '*closed before onboarding finished*'
            $script:seenParams.WindowStyle | Should -Be 'Normal'
            $script:seenParams.Wait | Should -BeTrue
            $script:seenParams.FilePath | Should -Be (Get-Process -Id $PID).Path
        }

        It 'runs the consent in the child and returns its result with switches intact' {
            $result = Invoke-ConsentInSignInWindow -CmdletScript $script:fakeConsent -StartProcess $script:inConsole -ConsentParameters @{
                TenantId  = 'tenant-1'
                Force     = $true
                CreateNew = $true
                AdminUpn  = 'admin@contoso.onmicrosoft.com'
            }

            $result.ClientId | Should -Be 'client-for-tenant-1'
            $result.AppDisplayName | Should -Be 'force=True createNew=True upn=admin@contoso.onmicrosoft.com'
            $result.GraphPermissions[0].Permission | Should -Be 'User.Read.All'
        }

        It "throws the child's error when the consent fails" {
            {
                Invoke-ConsentInSignInWindow -CmdletScript $script:fakeConsent -StartProcess $script:inConsole -ConsentParameters @{ TenantId = 'fail-tenant' }
            } | Should -Throw '*consent blew up*'
        }

        It 'removes its parameter and result files' {
            $before = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Directory -Filter 'm365-onboard-*' -ErrorAction SilentlyContinue).Count
            Invoke-ConsentInSignInWindow -CmdletScript $script:fakeConsent -StartProcess $script:inConsole -ConsentParameters @{ TenantId = 'tenant-2' } | Out-Null
            $after = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Directory -Filter 'm365-onboard-*' -ErrorAction SilentlyContinue).Count
            $after | Should -Be $before
        }
    }

    Context 'Invoke-TenantOnboarding routing' {
        It 'runs the consent in-process when the worker has a console window' {
            Mock Test-WorkerHasConsoleWindow { $true }
            Mock Invoke-ConsentInSignInWindow { throw 'should not open a window' }

            $result = Invoke-TenantOnboarding -TenantId 'tenant-3' -Confirmed $true -CmdletScript $script:fakeConsent

            $result.status | Should -Be 'succeeded'
            $result.clientId | Should -Be 'client-for-tenant-3'
            Should -Invoke Invoke-ConsentInSignInWindow -Times 0 -Exactly
        }

        It 'uses the sign-in window when the worker has no console window' {
            Mock Test-WorkerHasConsoleWindow { $false }
            Mock Invoke-ConsentInSignInWindow {
                [pscustomobject]@{ ClientId = 'from-window'; CertificateThumbprint = 'T'; TotalFailed = 0; GraphPermissions = @(); ComplianceRoles = @(); ExoRoleGroups = @() }
            }

            $result = Invoke-TenantOnboarding -TenantId 'tenant-4' -AdminUpn 'admin@contoso.onmicrosoft.com' -CreateNew -Confirmed $true -CmdletScript $script:fakeConsent

            $result.status | Should -Be 'succeeded'
            $result.clientId | Should -Be 'from-window'
            Should -Invoke Invoke-ConsentInSignInWindow -Times 1 -Exactly -ParameterFilter {
                $ConsentParameters['TenantId'] -eq 'tenant-4' -and $ConsentParameters['Force'] -and $ConsentParameters['CreateNew']
            }
        }

        It 'reports a window failure as onboard.failed' {
            Mock Test-WorkerHasConsoleWindow { $false }
            Mock Invoke-ConsentInSignInWindow { throw 'The onboarding sign-in window closed before onboarding finished' }

            $result = Invoke-TenantOnboarding -TenantId 'tenant-5' -Confirmed $true -CmdletScript $script:fakeConsent

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'closed before onboarding finished'
            $result.error | Should -Match 'onboard.failed'
        }
    }

    Context 'Test-WorkerHasConsoleWindow' {
        It 'reports a console window off Windows, where WAM does not apply' -Skip:$IsWindows {
            Test-WorkerHasConsoleWindow | Should -BeTrue
        }

        It 'returns a boolean on Windows' -Skip:(-not $IsWindows) {
            Test-WorkerHasConsoleWindow | Should -BeOfType [bool]
        }
    }
}
