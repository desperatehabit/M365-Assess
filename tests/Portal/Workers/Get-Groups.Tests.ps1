BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:worker = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Get-Groups.ps1'
    $script:entrypoint = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/get-groups.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }
    function global:Get-UnifiedGroup {
        param($Identity, $ResultSize)
    }
    function global:Get-DistributionGroup {
        param($Identity, $ResultSize)
    }

    . $script:worker
}

AfterAll {
    Remove-Item -Path 'Function:\Invoke-MgGraphRequest' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-UnifiedGroup' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Get-DistributionGroup' -ErrorAction SilentlyContinue
}

Describe 'Get-Groups worker (T-0261, T-0900)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command -Name 'Get-Groups' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'Read-GroupsJob' -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
        }

        It 'does not select invalid requireSenderAuthenticationEnabled property from Graph v1.0 /groups' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $selectMatches = [regex]::Matches($source, '/v1\.0/groups\?[^\r\n"]+')
            $selectMatches.Count | Should -BeGreaterThan 0
            foreach ($match in $selectMatches) {
                $match.Value | Should -Not -Match 'requireSenderAuthenticationEnabled'
            }
        }
    }

    Context 'Get-Groups live mapping, type discrimination, and EXO enrichment' {
        BeforeEach {
            $script:requestedUris = [System.Collections.Generic.List[string]]::new()
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                $script:requestedUris.Add($Uri)
                return @{
                    value = @(
                        @{
                            id                    = 'grp-m365'
                            displayName           = 'All Company Team'
                            description           = 'Company wide M365 group'
                            groupTypes            = @('Unified')
                            mailEnabled           = $true
                            securityEnabled       = $true
                            mail                  = 'allcompany@example.invalid'
                            membershipRule        = $null
                            hideFromAddressLists  = $false
                            'members@odata.count' = 15
                            'owners@odata.count'  = 2
                        }
                        @{
                            id                    = 'grp-sec'
                            displayName           = 'SG-Tier1-Admins'
                            description           = 'Security group for tier 1 admins'
                            groupTypes            = @()
                            mailEnabled           = $false
                            securityEnabled       = $true
                            mail                  = $null
                            membershipRule        = $null
                            hideFromAddressLists  = $true
                            'members@odata.count' = 5
                            'owners@odata.count'  = 1
                        }
                        @{
                            id                    = 'grp-dist'
                            displayName           = 'Finance Distro'
                            description           = 'Distribution group for finance'
                            groupTypes            = @()
                            mailEnabled           = $true
                            securityEnabled       = $false
                            mail                  = 'finance@example.invalid'
                            membershipRule        = $null
                            hideFromAddressLists  = $false
                            'members@odata.count' = 0
                            'owners@odata.count'  = 1
                        }
                        @{
                            id                    = 'grp-mes'
                            displayName           = 'Mail Security Team'
                            description           = 'Mail-enabled security group'
                            groupTypes            = @()
                            mailEnabled           = $true
                            securityEnabled       = $true
                            mail                  = 'mailsec@example.invalid'
                            membershipRule        = $null
                            hideFromAddressLists  = $false
                            'members@odata.count' = 8
                            'owners@odata.count'  = 1
                        }
                        @{
                            id                    = 'grp-dyn'
                            displayName           = 'Dynamic Engineering'
                            description           = 'Engineering department dynamic'
                            groupTypes            = @('DynamicMembership')
                            mailEnabled           = $false
                            securityEnabled       = $true
                            mail                  = $null
                            membershipRule        = '(user.department -eq "Engineering")'
                            hideFromAddressLists  = $false
                            'members@odata.count' = 60
                            'owners@odata.count'  = 2
                        }
                    )
                }
            }

            Mock Get-UnifiedGroup {
                return @(
                    [pscustomobject]@{
                        ExternalDirectoryObjectId          = 'grp-m365'
                        PrimarySmtpAddress                 = 'allcompany@example.invalid'
                        HiddenFromAddressListsEnabled      = $true
                        RequireSenderAuthenticationEnabled = $true
                        GrantSendOnBehalfTo                = @('delegate1@example.invalid')
                    }
                )
            }

            Mock Get-DistributionGroup {
                return @(
                    [pscustomobject]@{
                        ExternalDirectoryObjectId          = 'grp-dist'
                        PrimarySmtpAddress                 = 'finance@example.invalid'
                        HiddenFromAddressListsEnabled      = $false
                        RequireSenderAuthenticationEnabled = $true
                        GrantSendOnBehalfTo                = @('alice@example.invalid', 'bob@example.invalid')
                    }
                    [pscustomobject]@{
                        ExternalDirectoryObjectId          = 'grp-mes'
                        PrimarySmtpAddress                 = 'mailsec@example.invalid'
                        HiddenFromAddressListsEnabled      = $false
                        RequireSenderAuthenticationEnabled = $false
                        GrantSendOnBehalfTo                = @('sec-lead@example.invalid')
                    }
                )
            }
        }

        It 'returns all groups with type, counts, and EXO-enriched delivery and send-on-behalf' {
            $result = Get-Groups -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 5
            $result.items.Count | Should -Be 5
            $script:requestedUris[0] | Should -Not -Match 'requireSenderAuthenticationEnabled'

            $m365 = $result.items | Where-Object -FilterScript { $_.id -eq 'grp-m365' }
            $m365.type | Should -Be 'm365'
            $m365.membershipCount | Should -Be 15
            $m365.ownerCount | Should -Be 2
            $m365.hiddenFromAddressListsEnabled | Should -BeTrue
            $m365.deliveryManagementEnabled | Should -BeTrue
            $m365.grantSendOnBehalfTo | Should -Be @('delegate1@example.invalid')
            $m365.isDynamic | Should -BeFalse

            $sec = $result.items | Where-Object -FilterScript { $_.id -eq 'grp-sec' }
            $sec.type | Should -Be 'security'
            $sec.membershipCount | Should -Be 5
            $sec.hiddenFromAddressListsEnabled | Should -BeTrue
            $sec.deliveryManagementEnabled | Should -BeFalse
            $sec.grantSendOnBehalfTo.Count | Should -Be 0

            $dist = $result.items | Where-Object -FilterScript { $_.id -eq 'grp-dist' }
            $dist.type | Should -Be 'distribution'
            $dist.deliveryManagementEnabled | Should -BeTrue
            $dist.grantSendOnBehalfTo | Should -Be @('alice@example.invalid', 'bob@example.invalid')

            $mes = $result.items | Where-Object -FilterScript { $_.id -eq 'grp-mes' }
            $mes.type | Should -Be 'mailEnabledSecurity'
            $mes.deliveryManagementEnabled | Should -BeFalse
            $mes.grantSendOnBehalfTo | Should -Be @('sec-lead@example.invalid')

            $dyn = $result.items | Where-Object -FilterScript { $_.id -eq 'grp-dyn' }
            $dyn.type | Should -Be 'dynamic'
            $dyn.isDynamic | Should -BeTrue
            $dyn.dynamicRule | Should -Be '(user.department -eq "Engineering")'
        }

        It 'falls back gracefully when EXO cmdlets fail (not connected)' {
            Mock Get-UnifiedGroup { throw 'You must call Connect-ExchangeOnline first.' }
            Mock Get-DistributionGroup { throw 'You must call Connect-ExchangeOnline first.' }

            $result = Get-Groups -TenantId 'tenant-test'
            $result.totalCount | Should -Be 5

            $m365 = $result.items | Where-Object -FilterScript { $_.id -eq 'grp-m365' }
            $m365.hiddenFromAddressListsEnabled | Should -BeFalse
            $m365.deliveryManagementEnabled | Should -BeFalse
            $m365.grantSendOnBehalfTo.Count | Should -Be 0

            $dist = $result.items | Where-Object -FilterScript { $_.id -eq 'grp-dist' }
            $dist.deliveryManagementEnabled | Should -BeFalse
            $dist.grantSendOnBehalfTo.Count | Should -Be 0
        }

        It 'filters by type' {
            $result = Get-Groups -TenantId 'tenant-test' -Type 'distribution'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'grp-dist'
        }

        It 'filters by hidden' {
            $result = Get-Groups -TenantId 'tenant-test' -Hidden 'true'
            $result.totalCount | Should -Be 2
            ($result.items | ForEach-Object -Process { $_.id }) | Should -Contain 'grp-sec'
            ($result.items | ForEach-Object -Process { $_.id }) | Should -Contain 'grp-m365'
        }

        It 'filters by dynamic' {
            $result = Get-Groups -TenantId 'tenant-test' -Dynamic 'true'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'grp-dyn'
        }

        It 'filters by membershipSize' {
            $empty = Get-Groups -TenantId 'tenant-test' -MembershipSize 'empty'
            $empty.totalCount | Should -Be 1
            $empty.items[0].id | Should -Be 'grp-dist'

            $large = Get-Groups -TenantId 'tenant-test' -MembershipSize 'large'
            $large.totalCount | Should -Be 1
            $large.items[0].id | Should -Be 'grp-dyn'
        }

        It 'filters by search term' {
            $result = Get-Groups -TenantId 'tenant-test' -Search 'finance'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'grp-dist'
        }
    }
}
