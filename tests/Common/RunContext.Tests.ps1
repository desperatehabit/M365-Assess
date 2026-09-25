BeforeAll {
    . "$PSScriptRoot/../../src/M365-Assess/Common/RunContext.ps1"
}

Describe 'RunContext type (T-0001)' {
    BeforeAll {
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -Sections @('Identity', 'Email')
    }

    It 'is a RunContext instance' {
        $ctx.GetType().Name | Should -Be 'RunContext'
    }

    It 'exposes every SPEC 4.1 member group' {
        $members = $ctx.PSObject.Properties.Name
        foreach ($group in @('Tenant', 'Auth', 'Scope', 'Output', 'Services', 'Registry', 'Issues', 'Paths')) {
            $members | Should -Contain $group
        }
    }

    It 'exposes the Tenant config fields' {
        $fields = $ctx.Tenant.PSObject.Properties.Name
        foreach ($f in @('TenantId', 'DisplayName', 'DefaultDomain', 'InitialDomain')) {
            $fields | Should -Contain $f
        }
    }

    It 'exposes the Auth config fields' {
        $fields = $ctx.Auth.PSObject.Properties.Name
        foreach ($f in @('Method', 'ClientId', 'CertificateThumbprint', 'Certificate',
                         'CertificatePath', 'CertificatePassword', 'ClientSecret',
                         'UserPrincipalName', 'ManagedIdentity', 'UseDeviceCode', 'M365Environment')) {
            $fields | Should -Contain $f
        }
    }

    It 'exposes the Scope config fields' {
        $fields = $ctx.Scope.PSObject.Properties.Name
        foreach ($f in @('Sections', 'GraphScopes', 'SectionScopeMap', 'QuickScan', 'SeverityFilter')) {
            $fields | Should -Contain $f
        }
    }

    It 'exposes the Output config fields' {
        $fields = $ctx.Output.PSObject.Properties.Name
        foreach ($f in @('OutputFolder', 'AssessmentFolder', 'Timestamp', 'DomainPrefix',
                         'LogFilePath', 'LogFileName')) {
            $fields | Should -Contain $f
        }
    }

    It 'exposes the Services state fields' {
        $fields = $ctx.Services.PSObject.Properties.Name
        foreach ($f in @('Connected', 'Failed', 'PermissionsChecked', 'LicensesResolved')) {
            $fields | Should -Contain $f
        }
    }

    It 'exposes the Registry state fields' {
        $fields = $ctx.Registry.PSObject.Properties.Name
        foreach ($f in @('ControlRegistry', 'ProgressState')) {
            $fields | Should -Contain $f
        }
    }

    It 'exposes the Paths config fields' {
        $fields = $ctx.Paths.PSObject.Properties.Name
        foreach ($f in @('ProjectRoot', 'ConnectServicePath')) {
            $fields | Should -Contain $f
        }
    }

    It 'starts with mutable run state initialized' {
        $ctx.Services.Connected.GetType().Name | Should -Be 'HashSet`1'
        $ctx.Services.Failed.GetType().Name | Should -Be 'HashSet`1'
        $ctx.Issues.GetType().Name | Should -Be 'List`1'
        $ctx.Issues.Count | Should -Be 0
    }
}

Describe 'New-RunContext (T-0001)' {
    It 'resolves as a command' {
        Get-Command -Name New-RunContext -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }

    It 'builds a context from tenant, auth, scope, and output inputs' {
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -DisplayName 'Contoso Ltd' `
            -DefaultDomain 'contoso.com' -InitialDomain 'contoso.onmicrosoft.com' `
            -Auth @{ Method = 'Certificate'; ClientId = '11111111-1111-1111-1111-111111111111'; CertificateThumbprint = 'ABCDEF' } `
            -Sections @('Identity', 'Email') -GraphScopes @('User.Read.All') `
            -SectionScopeMap @{ Identity = @('User.Read.All') } `
            -OutputFolder './out' -Timestamp '20260101_120000'

        $ctx.GetType().Name | Should -Be 'RunContext'
        $ctx.Tenant.TenantId | Should -Be 'contoso.onmicrosoft.com'
        $ctx.Tenant.DisplayName | Should -Be 'Contoso Ltd'
        $ctx.Tenant.DefaultDomain | Should -Be 'contoso.com'
        $ctx.Auth.Method | Should -Be 'Certificate'
        $ctx.Auth.ClientId | Should -Be '11111111-1111-1111-1111-111111111111'
        $ctx.Auth.CertificateThumbprint | Should -Be 'ABCDEF'
        $ctx.Scope.Sections | Should -Be @('Identity', 'Email')
        $ctx.Scope.GraphScopes | Should -Be @('User.Read.All')
        $ctx.Scope.SectionScopeMap['Identity'] | Should -Be @('User.Read.All')
        $ctx.Output.OutputFolder | Should -Be './out'
        $ctx.Output.Timestamp | Should -Be '20260101_120000'
    }

    It 'applies CLI default output folder and sections' {
        $ctx = New-RunContext
        $ctx.Output.OutputFolder | Should -Be '.\M365-Assessment'
        $ctx.Scope.Sections | Should -Contain 'Identity'
        $ctx.Scope.Sections.Count | Should -Be 9
        $ctx.Auth.M365Environment | Should -Be 'commercial'
        $ctx.Scope.SeverityFilter.Count | Should -Be 0
    }

    It 'derives the assessment folder, log names, and timestamp' {
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -Timestamp '20260101_120000'
        $ctx.Output.DomainPrefix | Should -Be 'contoso'
        $ctx.Output.AssessmentFolder | Should -Be (Join-Path '.\M365-Assessment' 'Assessment_20260101_120000_contoso')
        $ctx.Output.LogFileName | Should -Be '_Assessment-Log_contoso.txt'
        $ctx.Output.LogFilePath | Should -Be (Join-Path $ctx.Output.AssessmentFolder '_Assessment-Log_contoso.txt')
    }

    It 'generates a timestamp when omitted' {
        $ctx = New-RunContext -TenantId '11111111-1111-1111-1111-111111111111'
        $ctx.Output.Timestamp | Should -Match '^\d{8}_\d{6}$'
        $ctx.Output.DomainPrefix | Should -Be ''
        $ctx.Output.AssessmentFolder | Should -Match 'Assessment_\d{8}_\d{6}$'
    }

    It 'extracts the prefix from a custom domain' {
        $ctx = New-RunContext -TenantId 'contoso.com'
        $ctx.Output.DomainPrefix | Should -Be 'contoso'
    }

    It 'sets the QuickScan severity filter' {
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -QuickScan
        $ctx.Scope.QuickScan | Should -BeTrue
        $ctx.Scope.SeverityFilter | Should -Be @('Critical', 'High')
    }

    It 'infers the auth method from the supplied material' {
        (New-RunContext -Auth @{ ManagedIdentity = $true }).Auth.Method | Should -Be 'ManagedIdentity'
        (New-RunContext -Auth @{ UseDeviceCode = $true }).Auth.Method | Should -Be 'DeviceCode'
        (New-RunContext -Auth @{ CertificateThumbprint = 'ABC' }).Auth.Method | Should -Be 'Certificate'
        (New-RunContext -Auth @{ ClientSecret = (ConvertTo-SecureString 'x' -AsPlainText -Force) }).Auth.Method | Should -Be 'ClientSecret'
        (New-RunContext).Auth.Method | Should -Be 'Interactive'
    }

    It 'rejects an empty sections list' {
        { New-RunContext -Sections @() } | Should -Throw
    }

    It 'rejects an empty output folder' {
        { New-RunContext -OutputFolder '' } | Should -Throw
    }
}

Describe 'RunContext JSON round-trip (T-0001)' {
    BeforeAll {
        $secretText = 'SuperSecretValue-DoNotSerialize'
        $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -DisplayName 'Contoso Ltd' `
            -Auth @{
                Method                = 'Certificate'
                ClientId              = '11111111-1111-1111-1111-111111111111'
                CertificateThumbprint = 'ABCDEF'
                Certificate           = [PSCustomObject]@{ Marker = 'LiveCertificateObject' }
                CertificatePassword   = (ConvertTo-SecureString $secretText -AsPlainText -Force)
                ClientSecret          = (ConvertTo-SecureString $secretText -AsPlainText -Force)
            } `
            -Sections @('Identity') -GraphScopes @('User.Read.All') -QuickScan -Timestamp '20260101_120000'
        [void]$ctx.Services.Connected.Add('Graph')
        [void]$ctx.Services.Failed.Add('PowerBI')
        $ctx.Services.PermissionsChecked = $true
        $ctx.Issues.Add([PSCustomObject]@{ Severity = 'ERROR'; Description = 'connection failed' })
    }

    It 'serializes without any secret-bearing value' {
        $json = ConvertTo-RunContextJson -Context $ctx
        $json | Should -Not -Match [regex]::Escape($secretText)
        $json | Should -Not -Match 'LiveCertificateObject'
        $json | Should -Not -Match 'CertificatePassword'
        $json | Should -Not -Match 'ClientSecret'
        $json | Should -Not -Match '"Certificate":'
    }

    It 'rehydrates a RunContext with configuration intact' {
        $json = ConvertTo-RunContextJson -Context $ctx
        $back = ConvertFrom-RunContextJson -Json $json

        $back.GetType().Name | Should -Be 'RunContext'
        $back.Tenant.TenantId | Should -Be 'contoso.onmicrosoft.com'
        $back.Tenant.DisplayName | Should -Be 'Contoso Ltd'
        $back.Auth.Method | Should -Be 'Certificate'
        $back.Auth.ClientId | Should -Be '11111111-1111-1111-1111-111111111111'
        $back.Auth.CertificateThumbprint | Should -Be 'ABCDEF'
        $back.Scope.Sections | Should -Be @('Identity')
        $back.Scope.GraphScopes | Should -Be @('User.Read.All')
        $back.Scope.QuickScan | Should -BeTrue
        $back.Scope.SeverityFilter | Should -Be @('Critical', 'High')
        $back.Output.AssessmentFolder | Should -Be $ctx.Output.AssessmentFolder
        $back.Output.LogFileName | Should -Be $ctx.Output.LogFileName
    }

    It 'rehydrates mutable run state and carries no secrets' {
        $json = ConvertTo-RunContextJson -Context $ctx
        $back = ConvertFrom-RunContextJson -Json $json

        $back.Services.Connected | Should -Contain 'Graph'
        $back.Services.Failed | Should -Contain 'PowerBI'
        $back.Services.PermissionsChecked | Should -BeTrue
        $back.Issues.Count | Should -Be 1
        $back.Issues[0].Description | Should -Be 'connection failed'
        $back.Auth.ClientSecret | Should -BeNullOrEmpty
        $back.Auth.CertificatePassword | Should -BeNullOrEmpty
        $back.Auth.Certificate | Should -BeNullOrEmpty
    }
}

Describe 'RunContext implementation constraints (T-0001)' {
    BeforeAll {
        $script:sourcePath = "$PSScriptRoot/../../src/M365-Assess/Common/RunContext.ps1"
    }

    It 'declares no $global: or $script: state of its own' {
        $content = Get-Content -Path $script:sourcePath -Raw
        $content | Should -Not -Match '\$global:'
        $content | Should -Not -Match '\$script:'
    }
}
