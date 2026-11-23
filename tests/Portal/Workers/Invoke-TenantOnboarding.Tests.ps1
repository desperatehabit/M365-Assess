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

    Context 'assessment read permissions' {
        It 'grants Agreement.Read.All through the onboarding consent run (T-0915)' {
            $definitions = Get-Content -LiteralPath (Join-Path $script:repoRoot 'src/M365-Assess/Setup/PermissionDefinitions.ps1') -Raw
            $definitions | Should -Match "Name = 'Agreement\.Read\.All'"
            $definitions | Should -Match 'ENTRA-TOU-001'
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

    Context 'opt-in operator write access (T-0917)' {
        It 'passes the selected write groups and danger confirmation to the cmdlet' {
            $seen = @{}
            $handler = {
                param($TenantId, $Force, $IncludeWritePermissions, $WritePermissionGroups, $ConfirmDangerous)
                $seen['IncludeWritePermissions'] = $IncludeWritePermissions
                $seen['WritePermissionGroups'] = @($WritePermissionGroups)
                $seen['ConfirmDangerous'] = $ConfirmDangerous
                return [pscustomobject]@{
                    ClientId                      = 'reader-app'
                    CertificateThumbprint         = 'READER-THUMB'
                    OperatorClientId              = 'operator-app'
                    OperatorCertificateThumbprint = 'READER-THUMB'
                    OperatorAppDisplayName        = 'M365-Assess-Operator'
                    OperatorCreated               = $true
                    WritePermissionGroups         = @('identity', 'intune')
                    TotalFailed                   = 0
                }
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId `
                                              -Confirmed $true `
                                              -IncludeWritePermissions `
                                              -WritePermissionGroups @('identity', 'intune') `
                                              -ConfirmDangerous `
                                              -CmdletHandler $handler

            $seen['IncludeWritePermissions'] | Should -BeTrue
            $seen['WritePermissionGroups'] | Should -Be @('identity', 'intune')
            $seen['ConfirmDangerous'] | Should -BeTrue
            $result.status | Should -Be 'succeeded'
            $result.operatorClientId | Should -Be 'operator-app'
            $result.operatorCertificateThumbprint | Should -Be 'READER-THUMB'
            $result.writePermissionGroups | Should -Be @('identity', 'intune')
        }

        It 'keeps the reader-only path when write access is not requested' {
            $seenWrite = $null
            $handler = {
                param($TenantId, $Force, $IncludeWritePermissions)
                $seenWrite = $IncludeWritePermissions
                return [pscustomobject]@{
                    ClientId              = 'reader-app'
                    CertificateThumbprint = 'READER-THUMB'
                    TotalFailed           = 0
                }
            }

            $result = Invoke-TenantOnboarding -TenantId $script:stubTenantId -Confirmed $true -CmdletHandler $handler

            $seenWrite | Should -BeFalse
            $result.operatorClientId | Should -BeNullOrEmpty
            $result.operatorAppDisplayName | Should -BeNullOrEmpty
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

Describe 'Onboarding prerequisites preflight (T-0915)' {
    # Onboarding needs these modules on the machine that runs the BFF; the worker reports
    # them before onboarding starts, with install commands pinned to the installed Graph
    # SDK version (mixing Graph module versions causes assembly load errors).

    Context 'Test-OnboardingPrerequisite' {
        It 'ships a preflight function and a worker entrypoint' {
            (Get-Command -Name 'Test-OnboardingPrerequisite' -CommandType Function) | Should -Not -BeNullOrEmpty
            Test-Path -LiteralPath (Join-Path $script:repoRoot 'portal/workers/onboarding-preflight.ps1') | Should -BeTrue
        }

        It 'reports ready when every onboarding module is installed' {
            $result = Test-OnboardingPrerequisite -InstalledModules @{
                'Microsoft.Graph.Authentication'      = '2.34.0'
                'Microsoft.Graph.Applications'        = '2.34.0'
                'Microsoft.Graph.Identity.Governance' = '2.34.0'
                'ExchangeOnlineManagement'            = '3.9.0'
            }

            $result.ready | Should -BeTrue
            @($result.missingModules).Count | Should -Be 0
            @($result.installCommands).Count | Should -Be 0
            $result.graphVersion | Should -Be '2.34.0'
            $result.modules.Count | Should -Be 4
            ($result.modules | Where-Object { -not $_.installed }).Count | Should -Be 0
        }

        It 'names a missing Graph module and pins its install to the installed Authentication version' {
            $result = Test-OnboardingPrerequisite -InstalledModules @{
                'Microsoft.Graph.Authentication' = '2.34.0'
                'Microsoft.Graph.Applications'   = '2.34.0'
                'ExchangeOnlineManagement'       = '3.9.0'
            }

            $result.ready | Should -BeFalse
            @($result.missingModules) | Should -Contain 'Microsoft.Graph.Identity.Governance'
            @($result.installCommands) | Should -Contain 'Install-Module Microsoft.Graph.Identity.Governance -RequiredVersion 2.34.0 -Scope CurrentUser -Force'
            $result.message | Should -Match 'Microsoft\.Graph\.Identity\.Governance'
            $result.message | Should -Match 'Install-Module Microsoft\.Graph\.Identity\.Governance -RequiredVersion 2\.34\.0'
            $result.message | Should -Match 'assembly load errors'
            $missingModule = $result.modules | Where-Object { $_.name -eq 'Microsoft.Graph.Identity.Governance' }
            $missingModule.installed | Should -BeFalse
            $missingModule.version | Should -BeNullOrEmpty
        }

        It 'does not pin ExchangeOnlineManagement to the Graph version' {
            $result = Test-OnboardingPrerequisite -InstalledModules @{
                'Microsoft.Graph.Authentication'      = '2.34.0'
                'Microsoft.Graph.Applications'        = '2.34.0'
                'Microsoft.Graph.Identity.Governance' = '2.34.0'
            }

            $result.ready | Should -BeFalse
            @($result.installCommands) | Should -Be @('Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force')
            $result.installCommands[0] | Should -Not -Match 'RequiredVersion'
            $result.message | Should -Match 'Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force'
        }

        It 'asks for Microsoft.Graph.Authentication first when the pin version is unknown' {
            $result = Test-OnboardingPrerequisite -InstalledModules @{
                'ExchangeOnlineManagement' = '3.9.0'
            }

            $result.ready | Should -BeFalse
            @($result.missingModules) | Should -Contain 'Microsoft.Graph.Authentication'
            @($result.installCommands) | Should -Contain 'Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force'
            $result.message | Should -Match 'Install it first'
            $result.message | Should -Match 'assembly load errors'
        }

        It 'probes this machine when no inventory is supplied' {
            $result = Test-OnboardingPrerequisite

            $result.modules.Count | Should -Be 4
            $result.ready | Should -BeOfType [bool]
            @($result.installCommands).Count | Should -Be (@($result.missingModules).Count)
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
    param($TenantId, [switch]$Force, [switch]$CreateNew, $AdminUpn, $AppDisplayName, $ClientId, $CertificateThumbprint, [switch]$UseDeviceCode, $SignInProgressCallback)
    if ($TenantId -eq 'fail-tenant') { throw 'consent blew up' }
    [pscustomobject]@{
        ClientId              = "client-for-$TenantId"
        CertificateThumbprint = 'THUMB'
        AppDisplayName        = "force=$($Force.IsPresent) createNew=$($CreateNew.IsPresent) upn=$AdminUpn deviceCode=$($UseDeviceCode.IsPresent)"
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
            $result.AppDisplayName | Should -Be 'force=True createNew=True upn=admin@contoso.onmicrosoft.com deviceCode=False'
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

Describe 'Headless device-code onboarding (T-0916)' {
    # A BFF with no interactive desktop cannot show the sign-in window. The worker then
    # runs the consent in-process with -UseDeviceCode and relays each code and
    # verification URL as a JSON progress line for the wizard.

    BeforeAll {
        $script:headlessDir = Join-Path ([System.IO.Path]::GetTempPath()) ("onboard-headless-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:headlessDir -Force | Out-Null

        $script:headlessConsent = Join-Path $script:headlessDir 'headless consent.ps1'
        Set-Content -LiteralPath $script:headlessConsent -Encoding utf8 -Value @'
function Grant-M365AssessConsent {
    [CmdletBinding()]
    param($TenantId, [switch]$Force, [switch]$CreateNew, $AdminUpn, $AppDisplayName, $ClientId, $CertificateThumbprint, [switch]$UseDeviceCode, $SignInProgressCallback)
    if ($TenantId -eq 'expired-tenant') {
        throw 'The device code for Exchange Online (exchange-online) expired before an operator signed in. Start onboarding again for a fresh code (code: onboard.device_code_expired).'
    }
    if ($UseDeviceCode -and $SignInProgressCallback) {
        & $SignInProgressCallback ([pscustomobject]@{
            Kind            = 'device-code'
            Stage           = 'graph-bootstrap'
            Provider        = 'Microsoft Graph'
            Code            = 'CODE-1234'
            VerificationUrl = 'https://microsoft.com/devicelogin'
            ExpiresOn       = (Get-Date).ToUniversalTime().AddMinutes(15)
            Message         = 'sign in'
        })
        & $SignInProgressCallback ([pscustomobject]@{
            Kind     = 'sign-in-complete'
            Stage    = 'graph-bootstrap'
            Provider = 'Microsoft Graph'
            Account  = $AdminUpn
        })
    }
    [pscustomobject]@{
        ClientId              = "client-for-$TenantId"
        CertificateThumbprint = 'THUMB'
        AppDisplayName        = "deviceCode=$($UseDeviceCode.IsPresent)"
        TotalFailed           = 0
        GraphPermissions      = @()
        ComplianceRoles       = @()
        ExoRoleGroups         = @()
    }
}
'@
    }

    AfterAll {
        Remove-Item -LiteralPath $script:headlessDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Context 'Test-InteractiveDesktop' {
        It 'reports no desktop when headless mode is forced' {
            Test-InteractiveDesktop -Headless -IsWindowsHost $true -UserInteractive $true -SessionId 1 | Should -BeFalse
        }

        It 'reports no desktop off Windows' {
            Test-InteractiveDesktop -IsWindowsHost $false -UserInteractive $true -SessionId 1 | Should -BeFalse
        }

        It 'reports no desktop for a non-interactive process' {
            Test-InteractiveDesktop -IsWindowsHost $true -UserInteractive $false -SessionId 1 | Should -BeFalse
        }

        It 'reports no desktop in session 0, where services run' {
            Test-InteractiveDesktop -IsWindowsHost $true -UserInteractive $true -SessionId 0 | Should -BeFalse
        }

        It 'reports a desktop for an interactive Windows session' {
            Test-InteractiveDesktop -IsWindowsHost $true -UserInteractive $true -SessionId 1 | Should -BeTrue
        }

        It 'honours the M365_PORTAL_HEADLESS escape hatch' {
            $previous = $env:M365_PORTAL_HEADLESS
            try {
                $env:M365_PORTAL_HEADLESS = 'true'
                Test-InteractiveDesktop -IsWindowsHost $true -UserInteractive $true -SessionId 1 | Should -BeFalse
            }
            finally {
                $env:M365_PORTAL_HEADLESS = $previous
            }
        }

        It 'returns a boolean on this machine' {
            Test-InteractiveDesktop | Should -BeOfType [bool]
        }
    }

    Context 'Invoke-TenantOnboarding routing' {
        It 'runs the consent in-process with device code and relays each code when there is no desktop' {
            Mock Test-InteractiveDesktop { $false }
            Mock Invoke-ConsentInSignInWindow { throw 'should not open a sign-in window' }
            $events = [System.Collections.Generic.List[object]]::new()

            $result = Invoke-TenantOnboarding -TenantId 'tenant-headless' `
                -AdminUpn 'admin@contoso.onmicrosoft.com' `
                -CreateNew `
                -Confirmed $true `
                -CmdletScript $script:headlessConsent `
                -ProgressChannel { param($event) $events.Add($event) }

            $result.status | Should -Be 'succeeded'
            $result.appDisplayName | Should -Be 'deviceCode=True'
            $events.Count | Should -Be 2
            $events[0].kind | Should -Be 'device-code'
            $events[0].signIn | Should -Be 'graph-bootstrap'
            $events[0].provider | Should -Be 'Microsoft Graph'
            $events[0].code | Should -Be 'CODE-1234'
            $events[0].verificationUrl | Should -Be 'https://microsoft.com/devicelogin'
            $events[0].sequence | Should -Be 1
            $events[0].schemaVersion | Should -Be 'v1'
            $events[0].expiresAt | Should -Not -BeNullOrEmpty
            $events[1].kind | Should -Be 'sign-in-complete'
            $events[1].sequence | Should -Be 2
            Should -Invoke Invoke-ConsentInSignInWindow -Times 0 -Exactly
        }

        It 'keeps the window path on a desktop and does not request device code' {
            Mock Test-InteractiveDesktop { $true }
            Mock Test-WorkerHasConsoleWindow { $false }
            Mock Invoke-ConsentInSignInWindow {
                [pscustomobject]@{ ClientId = 'from-window'; CertificateThumbprint = 'T'; TotalFailed = 0; AppDisplayName = 'deviceCode=False' }
            }

            $result = Invoke-TenantOnboarding -TenantId 'tenant-desktop' -Confirmed $true -CmdletScript $script:headlessConsent

            $result.status | Should -Be 'succeeded'
            $result.clientId | Should -Be 'from-window'
            Should -Invoke Invoke-ConsentInSignInWindow -Times 1 -Exactly
        }

        It 'reports an expired device code with a clear message' {
            Mock Test-InteractiveDesktop { $false }

            $result = Invoke-TenantOnboarding -TenantId 'expired-tenant' `
                -AdminUpn 'admin@contoso.onmicrosoft.com' `
                -Confirmed $true `
                -CmdletScript $script:headlessConsent

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'onboard\.device_code_expired'
            $result.error | Should -Match 'Start onboarding again'
        }
    }

    Context 'progress line' {
        It 'passes the event to the channel and stamps it as a v1 progress payload' {
            $script:relayEvent = $null
            $relay = Get-OnboardingSignInRelay -Channel { param($event) $script:relayEvent = $event }

            & $relay ([pscustomobject]@{
                Kind            = 'device-code'
                Stage           = 'exchange-online'
                Provider        = 'Exchange Online'
                Code            = 'LINE-CODE'
                VerificationUrl = 'https://microsoft.com/devicelogin'
                ExpiresOn       = (Get-Date).ToUniversalTime().AddMinutes(10)
            })

            $event = $script:relayEvent
            $event | Should -Not -BeNullOrEmpty
            $event['schemaVersion'] | Should -Be 'v1'
            $event['sequence'] | Should -Be 1
            $event['kind'] | Should -Be 'device-code'
            $event['signIn'] | Should -Be 'exchange-online'
            $event['code'] | Should -Be 'LINE-CODE'
            $event['verificationUrl'] | Should -Be 'https://microsoft.com/devicelogin'
            $event['expiresAt'] | Should -Not -BeNullOrEmpty
            ($event | ConvertTo-Json -Compress -Depth 4) | Should -Match '"code":"LINE-CODE"'
        }
    }
}
