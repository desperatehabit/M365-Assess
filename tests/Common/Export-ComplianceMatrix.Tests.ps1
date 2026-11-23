BeforeDiscovery {
    # Nothing needed at discovery time
}

Describe 'Export-ComplianceMatrix' {
    BeforeAll {
        $script:srcPath = "$PSScriptRoot/../../src/M365-Assess/Common/Export-ComplianceMatrix.ps1"
        Mock Write-Warning { }
    }

    Context 'when ImportExcel module is not available' {
        BeforeAll {
            Mock Get-Module { return $null } -ParameterFilter { $Name -eq 'ImportExcel' }
        }

        It 'should warn and return without error' {
            $result = & $script:srcPath -AssessmentFolder $TestDrive
            $result | Should -BeNullOrEmpty
            Should -Invoke Write-Warning -Times 1
        }
    }

    Context 'when assessment folder does not exist' {
        BeforeAll {
            Mock Get-Module {
                return [PSCustomObject]@{ Name = 'ImportExcel'; Version = [version]'7.8.0' }
            } -ParameterFilter { $Name -eq 'ImportExcel' }
            Mock Import-Module { }
        }

        It 'should throw an error for missing folder' {
            { & $script:srcPath -AssessmentFolder 'C:\nonexistent\folder' } 2>&1 | Should -Not -BeNullOrEmpty
        }
    }

    Context 'when assessment folder exists but has no CSV files' {
        BeforeAll {
            Mock Get-Module {
                return [PSCustomObject]@{ Name = 'ImportExcel'; Version = [version]'7.8.0' }
            } -ParameterFilter { $Name -eq 'ImportExcel' }
            Mock Import-Module { }

            # Create an empty assessment folder
            $testFolder = Join-Path $TestDrive 'empty-assessment'
            New-Item -Path $testFolder -ItemType Directory -Force | Out-Null
        }

        It 'should report missing summary CSV' {
            $result = try { & $script:srcPath -AssessmentFolder $testFolder 2>$null } catch { $null }
            # Script exits early when no summary CSV is found
            $result | Should -BeNullOrEmpty
        }
    }
}

BeforeDiscovery {
    $script:hasImportExcel = [bool](Get-Module -ListAvailable -Name ImportExcel)
}

Describe 'Export-ComplianceMatrix - strict pass rate (T-0938)' -Skip:(-not $script:hasImportExcel) {
    BeforeAll {
        Import-Module ImportExcel -ErrorAction Stop

        $script:srcPath = "$PSScriptRoot/../../src/M365-Assess/Common/Export-ComplianceMatrix.ps1"
        $script:fixture = Join-Path $TestDrive 'strict-rate'
        New-Item -Path $script:fixture -ItemType Directory -Force | Out-Null

        # Synthetic fixture: four CIS E3-L1/E5-L1 checks (one per scoring status)
        # plus one E5-L1-only check. The Review row makes Pass/(Pass+Fail+Warning)
        # differ from Pass/Mapped, so a non-strict formula is visible.
        @'
Section,Collector,FileName,Status,Items
Power BI,Get-PowerBISecurityConfig,22-PowerBI-Security-Config.csv,Failed,4
Entra,Get-PimReport,06-Entra-PIM.csv,Partial,1
'@ | Set-Content -Path (Join-Path $script:fixture '_Assessment-Summary_Pester.csv')

        @'
CheckId,Category,Setting,CurrentValue,RecommendedValue,Status,Remediation
POWERBI-GUEST-001.1,Guest Access,Guest User Access Restricted,True,True,Pass,Disable
POWERBI-AUTH-001.1,Authentication,Block ResourceKey Authentication,True,True,Fail,Enable
POWERBI-SHARING-001.1,Sharing,Publish to Web Restricted,False,True,Warning,Disable
POWERBI-INFOPROT-001.1,Information Protection,Sensitivity Labels Enabled,False,True,Review,Enable
'@ | Set-Content -Path (Join-Path $script:fixture '22-PowerBI-Security-Config.csv')

        @'
CheckId,Category,Setting,CurrentValue,RecommendedValue,Status,Remediation
ENTRA-PIM-002.1,Privileged Access,PIM Eligible Assignments,Test,Test,Pass,Review
'@ | Set-Content -Path (Join-Path $script:fixture '06-Entra-PIM.csv')

        & $script:srcPath -AssessmentFolder $script:fixture -TenantName 'Pester' | Out-Null

        $script:workbook = Join-Path $script:fixture '_Compliance-Matrix_Pester.xlsx'
        $script:summary = Import-Excel -Path $script:workbook -WorksheetName 'Summary'
        $script:grouped = Import-Excel -Path $script:workbook -WorksheetName 'Grouped by Profile'
    }

    It 'writes the Summary and Grouped by Profile sheets' {
        Test-Path -Path $script:workbook | Should -Be $true
        @($script:summary).Count | Should -BeGreaterThan 0
        @($script:grouped).Count | Should -BeGreaterThan 0
    }

    It 'shows the same E3-L1 pass rate on Summary and Grouped by Profile' {
        $summaryRow = $script:summary | Where-Object { $_.Framework -match '^\s*E3-L1\b' } | Select-Object -First 1
        $groupedRow = $script:grouped | Where-Object { $_.Profile -eq 'E3-L1' } | Select-Object -First 1

        $summaryRow | Should -Not -BeNullOrEmpty
        $groupedRow | Should -Not -BeNullOrEmpty
        # Strict: 1 Pass / (1 Pass + 1 Fail + 1 Warning) = 33.3%, not 1/4 = 25%.
        [math]::Round([double]$summaryRow.'Pass Rate %', 1) | Should -Be 33.3
        [math]::Round([double]$groupedRow.'Pass Rate %', 1) | Should -Be 33.3
    }

    It 'shows the same E5-L1 pass rate on Summary and Grouped by Profile' {
        $summaryRow = $script:summary | Where-Object { $_.Framework -match '^\s*E5-L1\b' } | Select-Object -First 1
        $groupedRow = $script:grouped | Where-Object { $_.Profile -eq 'E5-L1' } | Select-Object -First 1

        $summaryRow | Should -Not -BeNullOrEmpty
        $groupedRow | Should -Not -BeNullOrEmpty
        # Strict: 2 Pass / (2 Pass + 1 Fail + 1 Warning) = 50.0%, not 2/5 = 40%.
        [math]::Round([double]$summaryRow.'Pass Rate %', 1) | Should -Be 50
        [math]::Round([double]$groupedRow.'Pass Rate %', 1) | Should -Be 50
    }

    It 'shows the same combined E3 pass rate on Summary and Grouped by Profile' {
        $summaryRow = $script:summary | Where-Object { $_.Framework -match '^\s*E3 Combined' } | Select-Object -First 1
        $groupedRow = $script:grouped | Where-Object { $_.Profile -match '^E3 Combined' } | Select-Object -First 1

        $summaryRow | Should -Not -BeNullOrEmpty
        $groupedRow | Should -Not -BeNullOrEmpty
        [math]::Round([double]$summaryRow.'Pass Rate %', 1) | Should -Be 33.3
        [math]::Round([double]$groupedRow.'Pass Rate %', 1) | Should -Be 33.3
    }

    It 'uses the strict formula for every Summary profile row' {
        # Sub-rows are the indented framework/profile rows.
        $profileRows = @($script:summary | Where-Object { [string]$_.Framework -match '^\s{4}' })
        $profileRows.Count | Should -BeGreaterThan 0

        foreach ($row in $profileRows) {
            $denominator = [int]$row.Pass + [int]$row.Fail + [int]$row.Warning
            $expected = if ($denominator -gt 0) {
                [math]::Round(([int]$row.Pass / $denominator) * 100, 1)
            } else { 0 }
            [math]::Round([double]$row.'Pass Rate %', 1) | Should -Be $expected `
                -Because "Summary row '$($row.Framework)' must use Pass/(Pass+Fail+Warning)"
        }
    }

    It 'uses the strict formula for every Grouped by Profile row' {
        foreach ($row in $script:grouped) {
            $denominator = [int]$row.Passed + [int]$row.Failed + [int]$row.Warning
            $expected = if ($denominator -gt 0) {
                [math]::Round(([int]$row.Passed / $denominator) * 100, 1)
            } else { 0 }
            [math]::Round([double]$row.'Pass Rate %', 1) | Should -Be $expected `
                -Because "Grouped row '$($row.Profile)' must use Pass/(Pass+Fail+Warning)"
        }
    }
}
