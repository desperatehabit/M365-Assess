BeforeDiscovery {
    $moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    $script:pbiCases = @(Get-ChildItem -Path (Join-Path $moduleRoot 'Remediate/Scripts/PowerBI') -Filter '*.ps1' |
            ForEach-Object { @{ Path = $_.FullName; CheckId = $_.BaseName } })
}

BeforeAll {
    # In-memory Fabric tenant: settingName -> @{ enabled; groups }. The fakes
    # below run from inside the remediation scripts, where $script: would
    # point at the remediation script, so they reach the store unqualified
    # and tests mutate it in place via Set-FakeTenant.
    $FakeFabricTenant = @{}

    function Set-FakeTenant {
        param([hashtable]$State = @{})
        $FakeFabricTenant.Clear()
        foreach ($k in $State.Keys) { $FakeFabricTenant[$k] = $State[$k] }
    }

    function Get-PowerBIAccessToken { 'fake-token' }

    function Invoke-PowerBIRestMethod {
        param($Url, $Method, $Body, $ContentType)
        if ($Method -eq 'Get') {
            $list = foreach ($name in $FakeFabricTenant.Keys) {
                [ordered]@{
                    settingName           = $name
                    enabled               = $FakeFabricTenant[$name].enabled
                    enabledSecurityGroups = @($FakeFabricTenant[$name].groups | ForEach-Object { @{ graphId = $_ } })
                }
            }
            return (@{ tenantSettings = @($list) } | ConvertTo-Json -Depth 6)
        }
        if ($Url -match '/tenantsettings/([^/]+)/update$') {
            $b = $Body | ConvertFrom-Json
            $FakeFabricTenant[$Matches[1]] = @{ enabled = [bool]$b.enabled; groups = @($b.enabledSecurityGroups.graphId | Where-Object { $_ }) }
            return
        }
        throw "unexpected call $Method $Url"
    }

    function Get-DefaultSettingName {
        param([string]$Path)
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$null)
        ($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'SettingName' }).DefaultValue.Value
    }
}

Describe 'Power BI script <CheckId> against a simulated tenant' -ForEach $script:pbiCases {
    BeforeAll {
        $script:settingName = Get-DefaultSettingName -Path $Path
    }

    It 'treats exactly one of enabled/disabled as compliant under -WhatIf' {
        Set-FakeTenant -State @{ $script:settingName = @{ enabled = $true; groups = @() } }
        $whenOn = (& $Path -WhatIf).Status
        Set-FakeTenant -State @{ $script:settingName = @{ enabled = $false; groups = @() } }
        $whenOff = (& $Path -WhatIf).Status
        @($whenOn, $whenOff) | Sort-Object | Should -Be @('AlreadyCompliant', 'WhatIf')
    }

    It 'applies and verifies the change from the non-compliant state' {
        Set-FakeTenant -State @{ $script:settingName = @{ enabled = $true; groups = @() } }
        if ((& $Path -WhatIf).Status -eq 'AlreadyCompliant') {
            Set-FakeTenant -State @{ $script:settingName = @{ enabled = $false; groups = @() } }
        }
        $result = & $Path -Confirm:$false
        $result.Status | Should -Be 'Applied'
        (& $Path -WhatIf).Status | Should -Be 'AlreadyCompliant'
    }

    It 'reports Failed (not a throw) when the setting is missing from the tenant' {
        Set-FakeTenant -State @{}
        $result = & $Path -WhatIf
        $result.Status | Should -Be 'Failed'
        $result.Message | Should -Match 'was not returned'
    }
}

Describe 'Power BI group-scoped restriction' {
    It 'keeps the setting enabled for the given groups and verifies membership' {
        $path = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path 'Remediate/Scripts/PowerBI/POWERBI-AUTH-002.ps1'
        Set-FakeTenant -State @{ ServicePrincipalAccess = @{ enabled = $true; groups = @() } }
        $result = & $path -AllowedSecurityGroupId 'group-1' -Confirm:$false
        $result.Status | Should -Be 'Applied'
        $FakeFabricTenant.ServicePrincipalAccess.enabled | Should -BeTrue
        $FakeFabricTenant.ServicePrincipalAccess.groups | Should -Be @('group-1')
    }
}
