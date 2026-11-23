BeforeAll {
    # Grant-M365AssessConsent.ps1 dot-sources PermissionDefinitions.ps1, so stub the
    # interactive and external dependencies before loading.

    # Stub all Graph, EXO, and interactive cmdlets to prevent actual calls
    function global:Connect-MgGraph {
        param($TenantId, $ClientId, $CertificateThumbprint, $Scopes, $NoWelcome, $Environment, $Certificate, $AccessToken, [switch]$UseDeviceCode)
        if ($UseDeviceCode) {
            'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code TESTCODE1 to authenticate.'
        }
    }
    function global:Disconnect-MgGraph { }
    function global:Get-MgContext { [pscustomobject]@{ Account = 'admin@contoso.onmicrosoft.com'; AuthType = 'Delegated'; Environment = 'Global' } }
    function global:Get-MgApplication { param($Filter, $All) return @() }
    function global:New-MgApplication { param($DisplayName, $SignInAudience, $RequiredResourceAccess) return [PSCustomObject]@{ AppId = 'test-app-id'; Id = 'test-obj-id' } }
    function global:New-MgServicePrincipal { param($AppId) return [PSCustomObject]@{ Id = 'test-sp-id' } }
    function global:Get-MgServicePrincipal { param($Filter) return @() }
    function global:Get-MgServicePrincipalAppRoleAssignment { param($ServicePrincipalId) return @() }
    function global:New-MgServicePrincipalAppRoleAssignment { param($ServicePrincipalId, $BodyParameter) }
    function global:New-MgApplicationPassword { param($ApplicationId, $PasswordCredential) return [PSCustomObject]@{ SecretText = 'fake-secret' } }
    function global:New-MgDirectoryRoleMemberByRef { param($DirectoryRoleId, $BodyParameter) }
    function global:Remove-MgDirectoryRoleMemberByRef { param($DirectoryRoleId, $DirectoryObjectId) }
    function global:Get-MgDirectoryRole { param($Filter, $All) return @() }
    function global:Get-MgDirectoryRoleMember { param($DirectoryRoleId) return @() }
    function global:Get-MgDirectoryRoleMemberAsServicePrincipal { param($DirectoryRoleId, $All) return @() }
    function global:New-MgDirectoryRole { param($BodyParameter) return $null }
    function global:Remove-MgServicePrincipalAppRoleAssignment { param($ServicePrincipalId, $AppRoleAssignmentId) }
    function global:New-SelfSignedCertificate { param($Subject, $CertStoreLocation, $KeyExportPolicy, $NotAfter, $HashAlgorithm) return [PSCustomObject]@{ Thumbprint = 'GENERATED-THUMB' } }
    function global:Connect-ExchangeOnline { param($UserPrincipalName, $ShowProgress, $ShowBanner, $AccessToken, $Organization, [switch]$Device) }
    function global:Disconnect-ExchangeOnline { param($Confirm) }
    function global:Get-RoleGroup { param($Identity) return $null }
    function global:Add-RoleGroupMember { param($Identity, $Member) }
    function global:Remove-RoleGroupMember { param($Identity, $Member) }
    function global:Get-RoleGroupMember { param($Identity) return @() }
    function global:Get-ServicePrincipal { param($Identity) return $null }
    function global:New-ServicePrincipal { param($AppId, $ObjectId, $DisplayName) }
    function global:Start-Process { param($FilePath, $ArgumentList) }
    function global:Read-Host { param($Prompt) return '' }
    function global:Get-Item { param($Path) return $null }
    function global:Export-Certificate { param($Cert, $FilePath, $Type) }

    # Load the script (which dot-sources PermissionDefinitions.ps1 and defines Grant-M365AssessConsent)
    . "$PSScriptRoot/../../src/M365-Assess/Setup/Grant-M365AssessConsent.ps1"
}

AfterAll {
    Remove-Item -Path 'Function:\Connect-MgGraph' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Disconnect-MgGraph' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-MgContext' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-MgApplication' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-MgApplication' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-MgServicePrincipal' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-MgServicePrincipal' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-MgServicePrincipalAppRoleAssignment' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-MgServicePrincipalAppRoleAssignment' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-MgApplicationPassword' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-MgDirectoryRoleMemberByRef' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Remove-MgDirectoryRoleMemberByRef' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-MgDirectoryRole' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-MgDirectoryRoleMember' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-MgDirectoryRoleMemberAsServicePrincipal' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-MgDirectoryRole' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Remove-MgServicePrincipalAppRoleAssignment' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-SelfSignedCertificate' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Connect-ExchangeOnline' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Disconnect-ExchangeOnline' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-RoleGroup' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Add-RoleGroupMember' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Remove-RoleGroupMember' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-RoleGroupMember' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-ServicePrincipal' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\New-ServicePrincipal' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Start-Process' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Read-Host' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-Item' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Export-Certificate' -ErrorAction SilentlyContinue
}

Describe 'Grant-M365AssessConsent' {
    It 'should be defined as a function' {
        (Get-Command -Name 'Grant-M365AssessConsent' -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
    }

    It 'should have TenantId as a mandatory parameter' {
        $cmd = Get-Command -Name 'Grant-M365AssessConsent'
        $param = $cmd.Parameters['TenantId']
        $param | Should -Not -BeNullOrEmpty
    }

    It 'should have SkipGraph switch parameter' {
        $cmd = Get-Command -Name 'Grant-M365AssessConsent'
        $param = $cmd.Parameters['SkipGraph']
        $param | Should -Not -BeNullOrEmpty
    }

    It 'should have SkipExchangeRbac switch parameter' {
        $cmd = Get-Command -Name 'Grant-M365AssessConsent'
        $param = $cmd.Parameters['SkipExchangeRbac']
        $param | Should -Not -BeNullOrEmpty
    }

    It 'should have SkipComplianceRoles switch parameter' {
        $cmd = Get-Command -Name 'Grant-M365AssessConsent'
        $param = $cmd.Parameters['SkipComplianceRoles']
        $param | Should -Not -BeNullOrEmpty
    }

    It 'should have ProfileName parameter' {
        $cmd = Get-Command -Name 'Grant-M365AssessConsent'
        $param = $cmd.Parameters['ProfileName']
        $param | Should -Not -BeNullOrEmpty
    }

    Context 'high-impact ShouldProcess gate (E2 #791)' {
        It 'should declare SupportsShouldProcess on CmdletBinding' {
            $cmd = Get-Command -Name 'Grant-M365AssessConsent'
            $cmd.CmdletBinding | Should -BeTrue
            # SupportsShouldProcess surfaces a -WhatIf and -Confirm parameter
            $cmd.Parameters.ContainsKey('WhatIf')  | Should -BeTrue
            $cmd.Parameters.ContainsKey('Confirm') | Should -BeTrue
        }

        It 'should declare ConfirmImpact = High on CmdletBinding' {
            $cmd = Get-Command -Name 'Grant-M365AssessConsent'
            $attr = $cmd.ScriptBlock.Ast.Body.ParamBlock.Attributes |
                Where-Object { $_.TypeName.Name -eq 'CmdletBinding' }
            $attr | Should -Not -BeNullOrEmpty
            $confirmImpact = $attr.NamedArguments | Where-Object { $_.ArgumentName -eq 'ConfirmImpact' }
            $confirmImpact | Should -Not -BeNullOrEmpty
            $confirmImpact.Argument.Value | Should -Be 'High'
        }

        It 'should expose a -Force switch to bypass the confirmation prompt' {
            $cmd = Get-Command -Name 'Grant-M365AssessConsent'
            $param = $cmd.Parameters['Force']
            $param | Should -Not -BeNullOrEmpty
            $param.SwitchParameter | Should -BeTrue
        }

        It 'should suppress every later confirmation prompt when -Force is supplied' {
            # Non-interactive hosts (portal workers) throw on any ShouldProcess prompt, and the
            # function calls ShouldProcess per permission and role after the initial gate.
            $source = (Get-Command -Name 'Grant-M365AssessConsent').ScriptBlock.ToString()
            $source | Should -Match "(?s)else\s*\{[^}]*\`$ConfirmPreference\s*=\s*'None'"
        }

        It 'should not run any Graph mutation when -WhatIf is supplied' {
            # Track whether mutations were attempted; mocks would normally hit these
            $script:mutationAttempts = 0
            Mock New-MgApplication { $script:mutationAttempts++; [PSCustomObject]@{ AppId = 'x'; Id = 'y' } }
            Mock New-MgServicePrincipal { $script:mutationAttempts++; [PSCustomObject]@{ Id = 'sp' } }

            { Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' -CreateNew -AdminUpn 'admin@contoso.onmicrosoft.com' -WhatIf -ErrorAction Stop } |
                Should -Not -Throw

            $script:mutationAttempts | Should -Be 0
        }
    }
}

Describe 'Standalone load (portal onboarding worker)' {
    # The portal worker dot-sources this script on its own, outside the module, so every
    # helper the script calls must be loaded by the script itself.
    It 'loads Get-M365ConnectionProfile before the profile step uses it' {
        $source = Get-Content "$PSScriptRoot/../../src/M365-Assess/Setup/Grant-M365AssessConsent.ps1" -Raw
        $source | Should -Match "\.\s+\(Join-Path \`$PSScriptRoot 'Get-M365ConnectionProfile\.ps1'\)"
        $loadAt = $source.IndexOf("'Get-M365ConnectionProfile.ps1'")
        $callAt = $source.IndexOf('Get-M365ConnectionProfile -ErrorAction')
        $loadAt | Should -BeGreaterThan 0
        $loadAt | Should -BeLessThan $callAt
    }
}

Describe 'Device-code sign-in (T-0916)' {
    # Headless onboarding relays each code and verification URL to the wizard.
    # Microsoft.Graph.Authentication 2.41.2 has no device-code callback, so the code is
    # read from Connect-MgGraph -UseDeviceCode's output stream. ExchangeOnlineManagement
    # 3.7.2 -Device writes only to the console, so the MSAL device code flow supplies the
    # code and Connect-ExchangeOnline -AccessToken completes the sign-in.

    It 'exposes the device-code parameters' {
        $cmd = Get-Command -Name 'Grant-M365AssessConsent'
        $cmd.Parameters.ContainsKey('UseDeviceCode') | Should -BeTrue
        $cmd.Parameters.ContainsKey('SignInProgressCallback') | Should -BeTrue
        $cmd.Parameters.ContainsKey('DeviceCodeTokenAcquirer') | Should -BeTrue
        $cmd.Parameters['UseDeviceCode'].SwitchParameter | Should -BeTrue
    }

    It 'captures the pending Graph code and verification URL from the cmdlet output stream' {
        $events = [System.Collections.Generic.List[object]]::new()

        Connect-M365AssessGraphSession -TenantId 'contoso.onmicrosoft.com' `
            -Scopes 'Application.ReadWrite.All' `
            -UseDeviceCode `
            -Stage 'graph-bootstrap' `
            -SignInProgressCallback { param($event) $events.Add($event) }

        $events.Count | Should -Be 2
        $events[0].Kind | Should -Be 'device-code'
        $events[0].Provider | Should -Be 'Microsoft Graph'
        $events[0].Stage | Should -Be 'graph-bootstrap'
        $events[0].Code | Should -Be 'TESTCODE1'
        $events[0].VerificationUrl | Should -Be 'https://microsoft.com/devicelogin'
        $events[0].ExpiresOn | Should -Not -BeNullOrEmpty
        $events[1].Kind | Should -Be 'sign-in-complete'
    }

    It 'uses -UseDeviceCode instead of the desktop window' {
        $script:graphUseDeviceCode = $null
        Mock Connect-MgGraph {
            param($TenantId, $Scopes, $NoWelcome, [switch]$UseDeviceCode)
            $script:graphUseDeviceCode = $UseDeviceCode.IsPresent
        }

        Connect-M365AssessGraphSession -TenantId 'contoso.onmicrosoft.com' -Scopes 'User.Read' -UseDeviceCode

        $script:graphUseDeviceCode | Should -BeTrue
    }

    It 'keeps the interactive Graph sign-in when device code is off' {
        $script:graphUseDeviceCode = $null
        Mock Connect-MgGraph {
            param($TenantId, $Scopes, $NoWelcome, [switch]$UseDeviceCode)
            $script:graphUseDeviceCode = $UseDeviceCode.IsPresent
        }

        Connect-M365AssessGraphSession -TenantId 'contoso.onmicrosoft.com' -Scopes 'User.Read'

        $script:graphUseDeviceCode | Should -BeFalse
    }

    It 'connects Exchange Online with a device-code access token rather than -UserPrincipalName' {
        $script:exoParams = $null
        Mock Connect-ExchangeOnline {
            param($UserPrincipalName, $ShowBanner, $AccessToken, $Organization, [switch]$Device)
            $script:exoParams = @{
                UserPrincipalName = $UserPrincipalName
                AccessToken       = $AccessToken
                Organization      = $Organization
                Device            = $Device.IsPresent
            }
        }

        $acquirer = {
            param($request)
            $script:acquirerRequest = $request
            return 'fake-exo-token'
        }

        Connect-M365AssessExchangeSession -TenantId 'contoso.onmicrosoft.com' `
            -AdminUpn 'admin@contoso.onmicrosoft.com' `
            -UseDeviceCode `
            -DeviceCodeTokenAcquirer $acquirer

        $script:exoParams['AccessToken'] | Should -Be 'fake-exo-token'
        $script:exoParams['Organization'] | Should -Be 'contoso.onmicrosoft.com'
        $script:exoParams['UserPrincipalName'] | Should -BeNullOrEmpty
        $script:acquirerRequest.Resource | Should -Be 'exchange'
        $script:acquirerRequest.ClientId | Should -Be 'fb78d390-0c51-40cd-8e17-fdbfab77341b'
        $script:acquirerRequest.Scopes | Should -Contain 'https://outlook.office365.com/.default'
    }

    It 'asks the acquirer for a token and returns it' {
        $script:acquireRequest = $null
        $token = Get-M365DeviceCodeToken -Resource 'exchange' -TenantId 'contoso.onmicrosoft.com' -Stage 'exchange-online' -Acquirer {
            param($request)
            $script:acquireRequest = $request
            return 'token-123'
        }

        $token | Should -Be 'token-123'
        $script:acquireRequest.Stage | Should -Be 'exchange-online'
        $script:acquireRequest.TenantId | Should -Be 'contoso.onmicrosoft.com'
    }

    It 'requires -AdminUpn for the delegated steps instead of prompting a hidden console' {
        {
            Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' -UseDeviceCode -Force -ErrorAction Stop
        } | Should -Throw '*consent.admin_upn_required*'
    }
}

Describe 'PermissionDefinitions.ps1 - Data Tables' {
    # PermissionDefinitions.ps1 is dot-sourced by Grant-M365AssessConsent.ps1
    # The script variables are in function scope, so verify the definitions via reflection

    It 'should define required Graph permissions constant in script' {
        $content = Get-Content "$PSScriptRoot/../../src/M365-Assess/Setup/PermissionDefinitions.ps1" -Raw
        $content | Should -Match 'RequiredGraphPermissions'
    }

    It 'should define required EXO role groups constant in script' {
        $content = Get-Content "$PSScriptRoot/../../src/M365-Assess/Setup/PermissionDefinitions.ps1" -Raw
        $content | Should -Match 'RequiredExoRoleGroups'
    }

    It 'should define required compliance roles constant in script' {
        $content = Get-Content "$PSScriptRoot/../../src/M365-Assess/Setup/PermissionDefinitions.ps1" -Raw
        $content | Should -Match 'RequiredComplianceRoles'
    }

    It 'should include the read-only Agreement.Read.All permission for Terms of Use (T-0915)' {
        $content = Get-Content "$PSScriptRoot/../../src/M365-Assess/Setup/PermissionDefinitions.ps1" -Raw
        $content | Should -Match "Name = 'Agreement\.Read\.All'"
        $content | Should -Match 'ENTRA-TOU-001'
    }

    It 'should grant no write permission in the reader set (T-0917 owns the write set)' {
        $content = Get-Content "$PSScriptRoot/../../src/M365-Assess/Setup/PermissionDefinitions.ps1" -Raw
        # The write groups below are allowed to name ReadWrite permissions; the reader
        # table itself must stay read-only.
        $readerBlock = [regex]::Match(
            $content,
            '(?s)\$script:RequiredGraphPermissions\s*=\s*@\((.*?)\r?\n\)'
        ).Groups[1].Value
        $readerBlock | Should -Not -BeNullOrEmpty
        $readerBlock | Should -Not -Match 'ReadWrite'
        $names = [regex]::Matches($readerBlock, "(?m)^\s*@\{\s*Name\s*=\s*'([^']+)'") | ForEach-Object { $_.Groups[1].Value }
        $names.Count | Should -BeGreaterThan 0
        foreach ($name in $names) {
            $name | Should -Match '\.Read'
        }
    }
}

Describe 'Operator write reconciliation (T-0942)' {
    # -ReplaceWriteGroups adds the selected grants and removes the managed operator
    # grants that are no longer selected. It never removes an assignment outside the
    # T-0917 matrix and never touches the reader app.

    BeforeEach {
        $script:removedAssignments = [System.Collections.Generic.List[object]]::new()
        $script:removedDirectoryMembers = [System.Collections.Generic.List[object]]::new()
        $script:removedRoleGroupMembers = [System.Collections.Generic.List[object]]::new()
        $script:readerAssignmentReads = 0

        $script:graphSp = [pscustomobject]@{
            Id       = 'graph-sp'
            AppRoles = @(
                [pscustomobject]@{ Id = 'role-user-rw'; Value = 'User.ReadWrite.All' }
                [pscustomobject]@{ Id = 'role-sec-incident'; Value = 'SecurityIncident.ReadWrite.All' }
                [pscustomobject]@{ Id = 'role-reports'; Value = 'Reports.Read.All' }
                [pscustomobject]@{ Id = 'role-exo-manage'; Value = 'Exchange.ManageAsApp' }
                [pscustomobject]@{ Id = 'role-exo-org'; Value = 'Organization.Read.All' }
                [pscustomobject]@{ Id = 'role-purview'; Value = 'Purview.ApplicationAccess' }
            )
        }
        $script:exoResourceSp = [pscustomobject]@{
            Id       = 'exo-resource'
            AppRoles = @(
                [pscustomobject]@{ Id = 'role-exo-manage'; Value = 'Exchange.ManageAsApp' }
                [pscustomobject]@{ Id = 'role-exo-org'; Value = 'Organization.Read.All' }
                [pscustomobject]@{ Id = 'role-mailbox'; Value = 'MailboxSettings.Read' }
            )
        }
        $script:purviewResourceSp = [pscustomobject]@{
            Id       = 'purview-resource'
            AppRoles = @([pscustomobject]@{ Id = 'role-purview'; Value = 'Purview.ApplicationAccess' })
        }

        Mock Get-MgApplication {
            param($Filter)
            if ($Filter -match "displayName eq 'M365-Assess-Operator'") {
                return @([pscustomobject]@{
                    Id             = 'operator-obj'
                    AppId          = 'operator-app'
                    KeyCredentials = @([pscustomobject]@{ DisplayName = 'CN=M365-Assess-contoso.onmicrosoft.com' })
                })
            }
            return [pscustomobject]@{
                Id             = 'reader-obj'
                AppId          = 'reader-client'
                DisplayName    = 'M365-Assess-Reader'
                KeyCredentials = @()
            }
        }
        Mock Get-MgServicePrincipal {
            param($Filter)
            if ($Filter -match 'appId eq .reader-client.') { return [pscustomobject]@{ Id = 'reader-sp'; AppRoles = @() } }
            if ($Filter -match 'appId eq .operator-app.') { return [pscustomobject]@{ Id = 'operator-sp'; AppRoles = @() } }
            if ($Filter -match '00000003-0000-0000-c000-000000000000') { return $script:graphSp }
            if ($Filter -match '00000002-0000-0ff1-ce00-000000000000') { return $script:exoResourceSp }
            if ($Filter -match '00000007-0000-0ff1-ce00-000000000000') { return $script:purviewResourceSp }
            return $null
        }
        Mock Get-MgServicePrincipalAppRoleAssignment {
            param($ServicePrincipalId)
            if ($ServicePrincipalId -eq 'reader-sp') {
                $script:readerAssignmentReads++
                return @()
            }
            if ($ServicePrincipalId -ne 'operator-sp') { return @() }
            return @(
                [pscustomobject]@{ Id = 'assign-user-rw'; AppRoleId = 'role-user-rw'; ResourceId = 'graph-sp' }
                [pscustomobject]@{ Id = 'assign-sec'; AppRoleId = 'role-sec-incident'; ResourceId = 'graph-sp' }
                [pscustomobject]@{ Id = 'assign-reports'; AppRoleId = 'role-reports'; ResourceId = 'graph-sp' }
                [pscustomobject]@{ Id = 'assign-exo-manage'; AppRoleId = 'role-exo-manage'; ResourceId = 'exo-resource' }
                [pscustomobject]@{ Id = 'assign-exo-org'; AppRoleId = 'role-exo-org'; ResourceId = 'exo-resource' }
                [pscustomobject]@{ Id = 'assign-purview'; AppRoleId = 'role-purview'; ResourceId = 'purview-resource' }
            )
        }
        Mock Remove-MgServicePrincipalAppRoleAssignment {
            param($ServicePrincipalId, $AppRoleAssignmentId)
            $script:removedAssignments.Add([pscustomobject]@{ ServicePrincipalId = $ServicePrincipalId; Id = $AppRoleAssignmentId })
        }
        Mock Get-MgDirectoryRole {
            param($Filter)
            if ($Filter -match '29232cdf-9323-42fd-ade2-1d097af3e4de') { return [pscustomobject]@{ Id = 'dir-exchange' } }
            if ($Filter -match '5f2222b1-57c3-48ba-8ad5-d4759f1fde6f') { return [pscustomobject]@{ Id = 'dir-ediscovery' } }
            if ($Filter -match '69091246-20e8-4a56-aa4d-066075b2a7a8') { return [pscustomobject]@{ Id = 'dir-teams' } }
            return $null
        }
        Mock Get-MgDirectoryRoleMemberAsServicePrincipal {
            param($DirectoryRoleId)
            if ($DirectoryRoleId -eq 'dir-exchange') { return @([pscustomobject]@{ Id = 'operator-sp' }) }
            return @()
        }
        Mock Remove-MgDirectoryRoleMemberByRef {
            param($DirectoryRoleId, $DirectoryObjectId)
            $script:removedDirectoryMembers.Add([pscustomobject]@{ DirectoryRoleId = $DirectoryRoleId; DirectoryObjectId = $DirectoryObjectId })
        }
        Mock Connect-M365AssessExchangeSession { }
        Mock Get-Item {
            param($Path)
            return [pscustomobject]@{
                Subject   = 'CN=M365-Assess-contoso.onmicrosoft.com'
                NotBefore = (Get-Date).AddDays(-1)
                NotAfter  = (Get-Date).AddYears(1)
                RawData   = [byte[]](1, 2, 3)
                Thumbprint = 'THUMB'
            }
        }
        Mock Get-ServicePrincipal { param($Identity) return [pscustomobject]@{ ObjectId = $Identity } }
        Mock Get-RoleGroupMember {
            param($Identity)
            if ($Identity -eq 'Exchange Administrator') {
                return @([pscustomobject]@{ Name = 'M365-Assess-Operator'; Id = 'operator-sp' })
            }
            return @()
        }
        Mock Remove-RoleGroupMember {
            param($Identity, $Member)
            $script:removedRoleGroupMembers.Add([pscustomobject]@{ Identity = $Identity; Member = $Member })
        }
    }

    It 'removes the unselected managed Graph grant, directory role, and app role and leaves unrelated grants alone' {
        $result = Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
            -ClientId 'reader-client' -CertificateThumbprint 'THUMB' `
            -AdminUpn 'admin@contoso.onmicrosoft.com' `
            -IncludeWritePermissions -WritePermissionGroups @('security') -ReplaceWriteGroups `
            -SkipExchangeRbac -SkipComplianceRoles -Force

        $removedIds = @($script:removedAssignments | Select-Object -ExpandProperty Id)
        $removedIds | Should -Contain 'assign-user-rw'
        $removedIds | Should -Contain 'assign-exo-manage'
        $removedIds | Should -Contain 'assign-exo-org'
        $removedIds | Should -Contain 'assign-purview'
        $removedIds | Should -Not -Contain 'assign-sec'
        $removedIds | Should -Not -Contain 'assign-reports'
        @($script:removedAssignments | Where-Object { $_.ServicePrincipalId -eq 'reader-sp' }).Count | Should -Be 0

        @($script:removedDirectoryMembers).Count | Should -Be 1
        $script:removedDirectoryMembers[0].DirectoryRoleId | Should -Be 'dir-exchange'
        $script:removedDirectoryMembers[0].DirectoryObjectId | Should -Be 'operator-sp'

        $graphRemoved = @($result.OperatorGraphPermissions | Where-Object { $_.Status -eq 'Removed' } | Select-Object -ExpandProperty Permission)
        $graphRemoved | Should -Contain 'User.ReadWrite.All'
        $graphRemoved | Should -Contain 'Exchange.ManageAsApp'
        $graphRemoved | Should -Contain 'Purview.ApplicationAccess'
        $graphRemoved | Should -Not -Contain 'Reports.Read.All'
        $graphRemoved | Should -Not -Contain 'SecurityIncident.ReadWrite.All'

        $roleRemoved = @($result.OperatorDirectoryRoles | Where-Object { $_.Status -eq 'Removed' } | Select-Object -ExpandProperty Role)
        $roleRemoved | Should -Contain 'Exchange Administrator'
        @($result.OperatorRemoved).Count | Should -BeGreaterThan 0
    }

    It 'removes an unselected managed EXO role group even when no EXO group is selected' {
        Mock Get-MgServicePrincipal {
            param($Filter)
            if ($Filter -match 'appId eq .reader-client.') { return [pscustomobject]@{ Id = 'reader-sp'; AppRoles = @() } }
            if ($Filter -match 'appId eq .operator-app.') { return [pscustomobject]@{ Id = 'operator-sp'; AppRoles = @() } }
            return $null
        }

        $result = Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
            -ClientId 'reader-client' -CertificateThumbprint 'THUMB' `
            -AdminUpn 'admin@contoso.onmicrosoft.com' `
            -IncludeWritePermissions -WritePermissionGroups @('security') -ReplaceWriteGroups `
            -SkipGraph -SkipComplianceRoles -Force

        @($script:removedRoleGroupMembers).Count | Should -Be 1
        $script:removedRoleGroupMembers[0].Identity | Should -Be 'Exchange Administrator'
        $script:removedRoleGroupMembers[0].Member | Should -Be 'M365-Assess-Operator'
        $exoRemoved = @($result.OperatorExoRoleGroups | Where-Object { $_.Status -eq 'Removed' } | Select-Object -ExpandProperty RoleGroup)
        $exoRemoved | Should -Contain 'Exchange Administrator'
    }

    It 'removes nothing on a first run because the operator app holds no unselected grants' {
        Mock Get-MgServicePrincipalAppRoleAssignment { param($ServicePrincipalId) return @() }
        Mock Get-MgDirectoryRoleMemberAsServicePrincipal { param($DirectoryRoleId) return @() }
        Mock Get-RoleGroupMember { param($Identity) return @() }

        $result = Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
            -ClientId 'reader-client' -CertificateThumbprint 'THUMB' `
            -AdminUpn 'admin@contoso.onmicrosoft.com' `
            -IncludeWritePermissions -WritePermissionGroups @('identity', 'security', 'intune', 'sharepoint', 'exchange') `
            -ReplaceWriteGroups -ConfirmDangerous -SkipComplianceRoles -Force

        @($script:removedAssignments).Count | Should -Be 0
        @($script:removedDirectoryMembers).Count | Should -Be 0
        @($script:removedRoleGroupMembers).Count | Should -Be 0
        @($result.OperatorRemoved).Count | Should -Be 0
    }

    It 'shows what -ReplaceWriteGroups would remove under -WhatIf' {
        $output = Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
            -IncludeWritePermissions -WritePermissionGroups @('security') -ReplaceWriteGroups -WhatIf *>&1 | Out-String

        $output | Should -Match 'ReplaceWriteGroups would remove'
        $output | Should -Match 'User\.ReadWrite\.All'
        $output | Should -Match 'Exchange\.ManageAsApp'
        $output | Should -Match 'Exchange Administrator'
    }

    It 'requires -IncludeWritePermissions with -ReplaceWriteGroups' {
        {
            Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' -ReplaceWriteGroups -Force -ErrorAction Stop
        } | Should -Throw '*consent.replace_requires_write*'
    }
}

Describe 'Operator write permissions (T-0917)' {
    It 'defines the five write groups' {
        $selection = Get-M365AssessOperatorWriteSelection -Groups @('identity', 'security', 'intune', 'sharepoint', 'exchange')
        $selection.Groups | Sort-Object | Should -Be @('exchange', 'identity', 'intune', 'security', 'sharepoint')
    }

    It 'grants only the selected groups' {
        $selection = Get-M365AssessOperatorWriteSelection -Groups @('security')
        $selection.GraphPermissions | Should -Contain 'SecurityIncident.ReadWrite.All'
        $selection.GraphPermissions | Should -Not -Contain 'User.ReadWrite.All'
        $selection.GraphPermissions | Should -Not -Contain 'DeviceManagementManagedDevices.PrivilegedOperations.All'
        $selection.ExchangeAppRoles | Should -HaveCount 0
        $selection.DirectoryRoles | Should -HaveCount 0
        $selection.ExoRoleGroups | Should -HaveCount 0
    }

    It 'assigns Exchange/Purview/Teams roles only for the exchange group' {
        $identity = Get-M365AssessOperatorWriteSelection -Groups @('identity')
        $identity.DirectoryRoles | Should -HaveCount 0
        $identity.ExoRoleGroups | Should -HaveCount 0

        $exchange = Get-M365AssessOperatorWriteSelection -Groups @('exchange')
        $exchange.ExchangeAppRoles | Should -Contain 'Exchange.ManageAsApp'
        $exchange.ExoRoleGroups | Should -Contain 'Exchange Administrator'
        $exchange.DirectoryRoles | Should -Contain 'eDiscovery Manager'
        $exchange.DirectoryRoles | Should -Contain 'Teams Administrator'
    }

    It 'flags PIM role assignment, device wipe, and full SharePoint control as dangerous' {
        $identity = Get-M365AssessOperatorWriteSelection -Groups @('identity')
        $intune = Get-M365AssessOperatorWriteSelection -Groups @('intune')
        $sharepoint = Get-M365AssessOperatorWriteSelection -Groups @('sharepoint')

        $identity.DangerousPermissions | Should -Contain 'RoleAssignmentSchedule.ReadWrite.Directory'
        $identity.DangerousPermissions | Should -Contain 'RoleEligibilitySchedule.ReadWrite.Directory'
        $intune.DangerousPermissions | Should -Contain 'DeviceManagementManagedDevices.PrivilegedOperations.All'
        $sharepoint.DangerousPermissions | Should -Contain 'Sites.FullControl.All'
        (Get-M365AssessOperatorWriteSelection -Groups @('security')).DangerousPermissions | Should -HaveCount 0
    }

    It 'refuses dangerous write groups without -ConfirmDangerous and names them' {
        {
            Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
                -IncludeWritePermissions -WritePermissionGroups @('identity', 'intune') `
                -Force -ErrorAction Stop
        } | Should -Throw '*consent.dangerous_requires_confirmation*'

        {
            Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
                -IncludeWritePermissions -WritePermissionGroups @('identity') `
                -Force -ErrorAction Stop
        } | Should -Throw '*RoleAssignmentSchedule.ReadWrite.Directory*'
    }

    It 'requires at least one write group when write access is requested' {
        {
            Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
                -IncludeWritePermissions -Force -ErrorAction Stop
        } | Should -Throw '*consent.write_groups_required*'
    }

    It 'plans the operator grants under -WhatIf without requiring -AdminUpn' {
        $output = Grant-M365AssessConsent -TenantId 'contoso.onmicrosoft.com' `
            -IncludeWritePermissions -WritePermissionGroups @('security') -WhatIf *>&1 | Out-String

        $output | Should -Match 'M365-Assess-Operator'
        $output | Should -Match 'SecurityIncident\.ReadWrite\.All'
        $output | Should -Match 'reader app is not granted any write permission'
    }

    It 'exposes the opt-in parameters and returns operator fields' {
        $cmd = Get-Command -Name 'Grant-M365AssessConsent'
        $cmd.Parameters.ContainsKey('IncludeWritePermissions') | Should -BeTrue
        $cmd.Parameters.ContainsKey('WritePermissionGroups') | Should -BeTrue
        $cmd.Parameters.ContainsKey('ConfirmDangerous') | Should -BeTrue
        $cmd.Parameters.ContainsKey('ReplaceWriteGroups') | Should -BeTrue
        $source = Get-Content "$PSScriptRoot/../../src/M365-Assess/Setup/Grant-M365AssessConsent.ps1" -Raw
        $source | Should -Match 'OperatorClientId\s*='
        $source | Should -Match 'OperatorCertificateThumbprint\s*='
    }
}
