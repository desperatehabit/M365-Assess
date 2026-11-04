BeforeAll {
    $script:moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    . (Join-Path $script:moduleRoot 'Remediate/Scripts/Common/RemediationScriptHelper.ps1')

    # A minimal SupportsShouldProcess wrapper so Invoke-RemediationStep gets a
    # real $PSCmdlet whose -WhatIf / -Confirm behave like a script's.
    function Invoke-TestStep {
        [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
        param(
            [hashtable]$Step
        )
        Invoke-RemediationStep -Cmdlet $PSCmdlet @Step
    }

    function New-TestStep {
        param(
            [hashtable]$Store,
            [object]$Desired = $true
        )
        @{
            CheckId   = 'TEST-001'
            Target    = 'Test setting'
            Desired   = "Enabled = $Desired"
            GetState  = { [PSCustomObject]@{ Enabled = $Store.Enabled } }.GetNewClosure()
            TestState = { param($State) $State.Enabled -eq $true }
            SetState  = { param($State) $Store.Enabled = $true; $Store.SetCount++ }.GetNewClosure()
        }
    }
}

Describe 'Invoke-RemediationStep' {
    It 'reports AlreadyCompliant and does not write when the state is compliant' {
        $store = @{ Enabled = $true; SetCount = 0 }
        $result = Invoke-TestStep -Step (New-TestStep -Store $store) -Confirm:$false
        $result.Status | Should -Be 'AlreadyCompliant'
        $store.SetCount | Should -Be 0
    }

    It 'reports WhatIf and does not write under -WhatIf' {
        $store = @{ Enabled = $false; SetCount = 0 }
        $result = Invoke-TestStep -Step (New-TestStep -Store $store) -WhatIf
        $result.Status | Should -Be 'WhatIf'
        $result.Before.Enabled | Should -Be $false
        $store.SetCount | Should -Be 0
    }

    It 'applies, re-reads, and verifies when confirmed' {
        $store = @{ Enabled = $false; SetCount = 0 }
        $result = Invoke-TestStep -Step (New-TestStep -Store $store) -Confirm:$false
        $result.Status | Should -Be 'Applied'
        $result.Before.Enabled | Should -Be $false
        $result.After.Enabled | Should -Be $true
        $store.SetCount | Should -Be 1
    }

    It 'reports VerifyFailed when the change does not stick' {
        $store = @{ Enabled = $false; SetCount = 0 }
        $step = New-TestStep -Store $store
        $step.SetState = { param($State) $Store.SetCount++ }.GetNewClosure()
        $result = Invoke-TestStep -Step $step -Confirm:$false
        $result.Status | Should -Be 'VerifyFailed'
    }

    It 'reports Applied with -SkipVerify even when the re-read is not yet compliant' {
        $store = @{ Enabled = $false; SetCount = 0 }
        $step = New-TestStep -Store $store
        $step.SetState = { param($State) $Store.SetCount++ }.GetNewClosure()
        $step.SkipVerify = $true
        $result = Invoke-TestStep -Step $step -Confirm:$false
        $result.Status | Should -Be 'Applied'
        $result.Message | Should -Match 'verification skipped'
    }

    It 'reports Failed when the read throws, without writing' {
        $store = @{ Enabled = $false; SetCount = 0 }
        $step = New-TestStep -Store $store
        $step.GetState = { throw 'read boom' }
        $result = Invoke-TestStep -Step $step -Confirm:$false
        $result.Status | Should -Be 'Failed'
        $result.Message | Should -Match 'read boom'
        $store.SetCount | Should -Be 0
    }

    It 'reports Failed when the apply throws' {
        $store = @{ Enabled = $false; SetCount = 0 }
        $step = New-TestStep -Store $store
        $step.SetState = { param($State) throw 'write boom' }
        $result = Invoke-TestStep -Step $step -Confirm:$false
        $result.Status | Should -Be 'Failed'
        $result.Message | Should -Match 'write boom'
    }

    It 'passes the before-state to SetState' {
        $store = @{ Enabled = $false; SetCount = 0; Seen = $null }
        $step = New-TestStep -Store $store
        $step.SetState = { param($State) $Store.Seen = $State; $Store.Enabled = $true }.GetNewClosure()
        $null = Invoke-TestStep -Step $step -Confirm:$false
        $store.Seen.Enabled | Should -Be $false
    }
}

Describe 'Assert-RemediationConnection' {
    It 'throws when Microsoft Graph is not connected' {
        function Get-MgContext { $null }
        { Assert-RemediationConnection -Service Graph } | Should -Throw '*Connect-MgGraph*'
    }

    It 'warns when a required Graph scope is missing from a delegated context' {
        function Get-MgContext { [PSCustomObject]@{ Scopes = @('User.Read') } }
        Assert-RemediationConnection -Service Graph -GraphScope 'Policy.ReadWrite.Authorization' -WarningVariable warn -WarningAction SilentlyContinue
        "$warn" | Should -Match 'Policy.ReadWrite.Authorization'
    }

    It 'passes when the Graph context has the scope' {
        function Get-MgContext { [PSCustomObject]@{ Scopes = @('Policy.ReadWrite.Authorization') } }
        { Assert-RemediationConnection -Service Graph -GraphScope 'Policy.ReadWrite.Authorization' } | Should -Not -Throw
    }

    It 'passes for app-only Graph contexts that expose no scopes' {
        function Get-MgContext { [PSCustomObject]@{ Scopes = @() } }
        { Assert-RemediationConnection -Service Graph -GraphScope 'Policy.ReadWrite.Authorization' } | Should -Not -Throw
    }

    It 'distinguishes Exchange Online from Security & Compliance sessions' {
        function Get-ConnectionInformation { [PSCustomObject]@{ State = 'Connected'; IsEopSession = $true } }
        { Assert-RemediationConnection -Service SecurityCompliance } | Should -Not -Throw
        { Assert-RemediationConnection -Service ExchangeOnline } | Should -Throw '*Connect-ExchangeOnline*'
    }
}

Describe 'Test-RemediationProperty' {
    It 'matches flat and dotted paths' {
        $state = @{ a = $true; nested = @{ b = 'X' } }
        Test-RemediationProperty -State $state -Expected @{ a = $true; 'nested.b' = 'x' } | Should -BeTrue
        Test-RemediationProperty -State $state -Expected @{ 'nested.b' = 'y' } | Should -BeFalse
    }

    It 'does not treat a missing property as false' {
        Test-RemediationProperty -State @{} -Expected @{ a = $false } | Should -BeFalse
    }

    It 'requires a real boolean for boolean expectations' {
        Test-RemediationProperty -State @{ a = 'False' } -Expected @{ a = $false } | Should -BeFalse
    }

    It 'compares arrays as unordered sets' {
        Test-RemediationProperty -State @{ a = @('y', 'x') } -Expected @{ a = @('x', 'y') } | Should -BeTrue
        Test-RemediationProperty -State @{ a = @('x') } -Expected @{ a = @('x', 'y') } | Should -BeFalse
    }

    It 'works on PSObjects' {
        Test-RemediationProperty -State ([PSCustomObject]@{ a = 1 }) -Expected @{ a = 1 } | Should -BeTrue
    }
}

Describe 'Power BI tenant setting helpers' {
    BeforeEach {
        $script:pbiCalls = [System.Collections.Generic.List[object]]::new()
        function Invoke-PowerBIRestMethod {
            param($Url, $Method, $Body, $ContentType)
            $script:pbiCalls.Add([PSCustomObject]@{ Url = $Url; Method = $Method; Body = $Body })
            '{"tenantSettings":[{"settingName":"PublishToWeb","enabled":true}]}'
        }
    }

    It 'returns the named setting' {
        (Get-PowerBITenantSettingState -SettingName 'PublishToWeb').enabled | Should -Be $true
    }

    It 'throws a clear error for an unknown setting name' {
        { Get-PowerBITenantSettingState -SettingName 'Nope' } | Should -Throw "*'Nope' was not returned*"
    }

    It 'posts enabled=false to the Fabric update endpoint' {
        Set-PowerBITenantSettingState -SettingName 'PublishToWeb' -Enabled $false
        $call = $script:pbiCalls[-1]
        $call.Method | Should -Be 'Post'
        $call.Url | Should -Be 'https://api.fabric.microsoft.com/v1/admin/tenantsettings/PublishToWeb/update'
        ($call.Body | ConvertFrom-Json).enabled | Should -Be $false
    }

    It 'includes security groups only when enabling' {
        Set-PowerBITenantSettingState -SettingName 'PublishToWeb' -Enabled $true -EnabledSecurityGroupIds 'g1'
        (($script:pbiCalls[-1].Body | ConvertFrom-Json).enabledSecurityGroups.graphId) | Should -Be 'g1'
    }
}
