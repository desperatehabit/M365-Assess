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
