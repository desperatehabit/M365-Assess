BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-LisLocation.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-lis-location.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Invoke-LisLocation worker (T-0509)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-LisLocation -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-InvokeLisLocationJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-MissingCivicFields -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-CountryCodeFormat -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Civic field validation' {
        It 'identifies missing required civic fields' {
            $missing = Get-MissingCivicFields -DisplayName 'HQ' -Street '' -City 'Seattle' -State 'WA' -Country 'US' -PostalCode '98101'
            $missing -join ',' | Should -Be 'street'

            $missing = Get-MissingCivicFields -DisplayName '' -Street '' -City '' -State '' -Country '' -PostalCode ''
            $missing.Count | Should -Be 6
            ($missing -contains 'displayName') | Should -BeTrue
            ($missing -contains 'postalCode') | Should -BeTrue

            $missing = Get-MissingCivicFields -DisplayName 'HQ' -Street '1 Main St' -City 'Seattle' -State 'WA' -Country 'US' -PostalCode '98101'
            $missing.Count | Should -Be 0
        }

        It 'validates ISO 3166-1 alpha-2 country codes' {
            Test-CountryCodeFormat -Code 'US' | Should -BeTrue
            Test-CountryCodeFormat -Code 'gb' | Should -BeTrue

            Test-CountryCodeFormat -Code 'USA' | Should -BeFalse
            Test-CountryCodeFormat -Code '12' | Should -BeFalse
            Test-CountryCodeFormat -Code 'U' | Should -BeFalse
            Test-CountryCodeFormat -Code '' | Should -BeFalse
        }
    }

    Context 'List operation' {
        It 'lists LIS locations with civic address fields' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -eq '/v1.0/communications/lis/locations') {
                    return [pscustomobject]@{
                        value = @(
                            [pscustomobject]@{
                                id          = 'loc-1'
                                displayName = 'Corporate HQ'
                                street      = '1 Main St'
                                city        = 'Seattle'
                                state       = 'WA'
                                country     = 'US'
                                postalCode  = '98101'
                                companyName = 'Contoso Ltd'
                            },
                            [pscustomobject]@{
                                id          = 'loc-2'
                                displayName = 'Branch Office'
                                street      = '22 2nd Ave'
                                city        = 'Bellevue'
                                state       = 'WA'
                                country     = 'US'
                                postalCode  = '98004'
                            }
                        )
                    }
                }
                return $null
            }

            $res = Invoke-LisLocation -TenantId 'tenant-test' -Action 'list'
            $res.totalCount | Should -Be 2
            $res.tenantId | Should -Be 'tenant-test'

            $hq = $res.items | Where-Object { $_.id -eq 'loc-1' }
            $hq.displayName | Should -Be 'Corporate HQ'
            $hq.street | Should -Be '1 Main St'
            $hq.city | Should -Be 'Seattle'
            $hq.country | Should -Be 'US'
            $hq.postalCode | Should -Be '98101'
            $hq.companyName | Should -Be 'Contoso Ltd'

            $branch = $res.items | Where-Object { $_.id -eq 'loc-2' }
            $branch.displayName | Should -Be 'Branch Office'
            $branch.companyName | Should -Be ''
        }

        It 'reads a nested address object from the Graph response' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -eq '/v1.0/communications/lis/locations') {
                    return [pscustomobject]@{
                        value = @(
                            [pscustomobject]@{
                                id          = 'loc-9'
                                displayName = 'Nested Address'
                                address     = [pscustomobject]@{
                                    street         = '9 Pine St'
                                    city           = 'Portland'
                                    state          = 'OR'
                                    countryOrRegion = 'US'
                                    postalCode     = '97201'
                                }
                            }
                        )
                    }
                }
                return $null
            }

            $res = Invoke-LisLocation -TenantId 'tenant-test' -Action 'list'
            $item = $res.items | Where-Object { $_.id -eq 'loc-9' }
            $item.street | Should -Be '9 Pine St'
            $item.city | Should -Be 'Portland'
            $item.state | Should -Be 'OR'
            $item.country | Should -Be 'US'
            $item.postalCode | Should -Be '97201'
        }
    }

    Context 'Create operation' {
        It 'DryRun returns a plan preview without mutating' {
            $postCalled = $false
            Mock Invoke-MgGraphRequest {
                $postCalled = $true
            }

            $res = Invoke-LisLocation -TenantId 'tenant-test' -Action 'create' -DisplayName 'Branch Office' -Street '22 2nd Ave' -City 'Bellevue' -State 'WA' -Country 'US' -PostalCode '98004' -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'create'
            $res.plan.targetName | Should -Be 'Branch Office'
            $res.plan.dryRun | Should -BeTrue
            $postCalled | Should -BeFalse
        }

        It 'creates a LIS location and emits an audit event' {
            $script:capturedBody = $null
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'POST') {
                    $script:capturedBody = $Body | ConvertFrom-Json -AsHashtable
                    return [pscustomobject]@{ id = 'new-loc-id'; displayName = 'Branch Office' }
                }
                return $null
            }

            $res = Invoke-LisLocation -TenantId 'tenant-test' -Action 'create' -DisplayName 'Branch Office' -Street '22 2nd Ave' -City 'Bellevue' -State 'WA' -Country 'US' -PostalCode '98004' -CompanyName 'Contoso Ltd'
            $res.success | Should -BeTrue
            $res.plan.locationId | Should -Be 'new-loc-id'
            $script:capturedBody['displayName'] | Should -Be 'Branch Office'
            $script:capturedBody['street'] | Should -Be '22 2nd Ave'
            $script:capturedBody['city'] | Should -Be 'Bellevue'
            $script:capturedBody['state'] | Should -Be 'WA'
            $script:capturedBody['country'] | Should -Be 'US'
            $script:capturedBody['postalCode'] | Should -Be '98004'
            $script:capturedBody['companyName'] | Should -Be 'Contoso Ltd'

            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'teams.lis.create'
            $res.auditEvent.targetName | Should -Be 'Branch Office'
            $res.auditEvent.before | Should -BeNullOrEmpty
            $res.auditEvent.after | Should -Not -BeNullOrEmpty
        }

        It 'normalizes the country code to uppercase' {
            $script:capturedBody = $null
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'POST') {
                    $script:capturedBody = $Body | ConvertFrom-Json -AsHashtable
                    return [pscustomobject]@{ id = 'loc-lower' }
                }
                return $null
            }

            $res = Invoke-LisLocation -TenantId 'tenant-test' -Action 'create' -DisplayName 'Branch Office' -Street '22 2nd Ave' -City 'Bellevue' -State 'WA' -Country 'us' -PostalCode '98004'
            $res.success | Should -BeTrue
            $script:capturedBody['country'] | Should -Be 'US'
        }

        It 'rejects missing required civic fields' {
            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'create' -DisplayName 'Branch Office' -Street '' -City 'Bellevue' -State 'WA' -Country 'US' -PostalCode '98004' } | Should -Throw "*street*"
            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'create' -DisplayName '' -Street '22 2nd Ave' -City 'Bellevue' -State 'WA' -Country 'US' -PostalCode '98004' } | Should -Throw "*displayName*"
            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'create' -DisplayName 'Branch Office' -Street '22 2nd Ave' -City 'Bellevue' -State 'WA' -Country 'US' -PostalCode '' } | Should -Throw "*postalCode*"
        }

        It 'rejects an invalid country code' {
            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'create' -DisplayName 'Branch Office' -Street '22 2nd Ave' -City 'Bellevue' -State 'WA' -Country 'USA' -PostalCode '98004' } | Should -Throw "*Invalid country code*"
        }
    }

    Context 'Edit and Delete operations' {
        It 'edits an existing location, keeps fields it leaves out, and generates a diff' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET' -and $Uri -eq '/v1.0/communications/lis/locations/loc-1') {
                    return [pscustomobject]@{
                        id          = 'loc-1'
                        displayName = 'Corporate HQ'
                        street      = '1 Main St'
                        city        = 'Seattle'
                        state       = 'WA'
                        country     = 'US'
                        postalCode  = '98101'
                    }
                }
                if ($Method -eq 'PATCH') {
                    return [pscustomobject]@{ id = 'loc-1' }
                }
                return $null
            }

            $res = Invoke-LisLocation -TenantId 'tenant-test' -Action 'edit' -LocationId 'loc-1' -City 'Bellevue' -DryRun $true
            $res.plan.after.city | Should -Be 'Bellevue'
            $res.plan.after.street | Should -Be '1 Main St'
            $res.plan.after.displayName | Should -Be 'Corporate HQ'
            ($res.plan.diff -join "`n") | Should -Match "City"
        }

        It 'rejects an edit that would blank a required civic field' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET' -and $Uri -eq '/v1.0/communications/lis/locations/loc-1') {
                    return [pscustomobject]@{
                        id          = 'loc-1'
                        displayName = 'Corporate HQ'
                        street      = ''
                        city        = 'Seattle'
                        state       = 'WA'
                        country     = 'US'
                        postalCode  = '98101'
                    }
                }
                return $null
            }

            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'edit' -LocationId 'loc-1' -City 'Bellevue' } | Should -Throw "*street*"
        }

        It 'requires locationId for edit and delete' {
            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'edit' } | Should -Throw "*locationId is required*"
            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'delete' } | Should -Throw "*locationId is required*"
        }

        It 'deletes a location when confirmName matches' {
            $script:deleteCalled = $false
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET' -and $Uri -eq '/v1.0/communications/lis/locations/loc-1') {
                    return [pscustomobject]@{
                        id          = 'loc-1'
                        displayName = 'Corporate HQ'
                        street      = '1 Main St'
                        city        = 'Seattle'
                        state       = 'WA'
                        country     = 'US'
                        postalCode  = '98101'
                    }
                }
                if ($Method -eq 'DELETE') {
                    $script:deleteCalled = $true
                    return $null
                }
                return $null
            }

            $res = Invoke-LisLocation -TenantId 'tenant-test' -Action 'delete' -LocationId 'loc-1' -ConfirmName 'Corporate HQ'
            $res.success | Should -BeTrue
            $script:deleteCalled | Should -BeTrue
            $res.auditEvent.action | Should -Be 'teams.lis.delete'
            $res.auditEvent.before.displayName | Should -Be 'Corporate HQ'
            $res.auditEvent.after | Should -BeNullOrEmpty
        }

        It 'blocks delete when confirmName does not match' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET' -and $Uri -eq '/v1.0/communications/lis/locations/loc-1') {
                    return [pscustomobject]@{
                        id          = 'loc-1'
                        displayName = 'Corporate HQ'
                        street      = '1 Main St'
                        city        = 'Seattle'
                        state       = 'WA'
                        country     = 'US'
                        postalCode  = '98101'
                    }
                }
                return $null
            }

            { Invoke-LisLocation -TenantId 'tenant-test' -Action 'delete' -LocationId 'loc-1' -ConfirmName 'Wrong Name' } | Should -Throw "*confirmName must match*"
        }
    }

    Context 'Job envelope reading' {
        It 'reads all civic fields from a job file' {
            $path = Join-Path -Path $TestDrive -ChildPath 'lis-job.json'
            Set-Content -LiteralPath $path -Value '{"tenantId":"t","action":"create","displayName":"HQ","street":"1 Main St","city":"Seattle","state":"WA","country":"US","postalCode":"98101","companyName":"Contoso","dryRun":true}'
            $job = Read-InvokeLisLocationJob -Path $path
            $job['TenantId'] | Should -Be 't'
            $job['Action'] | Should -Be 'create'
            $job['DisplayName'] | Should -Be 'HQ'
            $job['Street'] | Should -Be '1 Main St'
            $job['City'] | Should -Be 'Seattle'
            $job['State'] | Should -Be 'WA'
            $job['Country'] | Should -Be 'US'
            $job['PostalCode'] | Should -Be '98101'
            $job['CompanyName'] | Should -Be 'Contoso'
            $job['DryRun'] | Should -BeTrue
        }

        It 'rejects a job file missing mandatory tenantId or action' {
            $path = Join-Path -Path $TestDrive -ChildPath 'lis-bad-job.json'
            Set-Content -LiteralPath $path -Value '{"action":"list"}'
            { Read-InvokeLisLocationJob -Path $path } | Should -Throw "*tenantId*"

            Set-Content -LiteralPath $path -Value '{"tenantId":"t"}'
            { Read-InvokeLisLocationJob -Path $path } | Should -Throw "*action*"
        }
    }
}
