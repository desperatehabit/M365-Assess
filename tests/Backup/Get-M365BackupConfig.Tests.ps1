BeforeAll {
    $script:collector = "$PSScriptRoot/../../src/M365-Assess/Backup/Get-M365BackupConfig.ps1"

    # Scenario data the Graph mock serves, keyed by URI pattern (first match wins).
    $script:graph = [ordered]@{}
    function script:Invoke-Collector {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $ErrorAction)
            if ($script:graph.Contains('Throw')) { throw $script:graph['Throw'] }
            foreach ($key in $script:graph.Keys) {
                if ($Uri -like $key) { return $script:graph[$key] }
            }
            return @{ value = @() }
        }
        & $script:collector | Where-Object { $_.CheckId -like 'BACKUP-ENABLED-001*' }
    }
}

Describe 'Get-M365BackupConfig' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
    }

    It 'passes when the service is enabled with an active policy' {
        $script:graph = [ordered]@{
            '*/exchangeProtectionPolicies'   = @{ value = @(@{ displayName = 'Mail'; status = 'active' }) }
            '*/sharePointProtectionPolicies' = @{ value = @(@{ displayName = 'Sites'; status = 'inactive' }) }
            '*/solutions/backupRestore'      = @{ serviceStatus = @{ status = 'enabled' } }
        }
        $row = Invoke-Collector
        $row.CheckId | Should -Match '^BACKUP-ENABLED-001\.\d+$'
        $row.Status | Should -Be 'Pass'
        $row.CurrentValue | Should -Match 'Exchange'
        $row.CurrentValue | Should -Match 'none for SharePoint, OneDrive'
    }

    It 'warns when the service is enabled but no policy is active' {
        $script:graph = [ordered]@{ '*/solutions/backupRestore' = @{ serviceStatus = @{ status = 'enabled' } } }
        (Invoke-Collector).Status | Should -Be 'Warning'
    }

    It 'fails when the service is disabled' {
        $script:graph = [ordered]@{ '*/solutions/backupRestore' = @{ serviceStatus = @{ status = 'disabled'; disableReason = 'invalidBillingProfile' } } }
        $row = Invoke-Collector
        $row.Status | Should -Be 'Fail'
        $row.CurrentValue | Should -Match 'invalidBillingProfile'
    }

    It 'is Review when the API is forbidden' {
        $script:graph = [ordered]@{ Throw = 'Response status code does not indicate success: 403 (Forbidden).' }
        $row = Invoke-Collector
        $row.Status | Should -Be 'Review'
        $row.CurrentValue | Should -Match 'Insufficient permissions'
    }

    AfterAll { Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue }
}
