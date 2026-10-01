<#
.SYNOPSIS
    Tests for T-0446: the EPIC-023 contact template shape worker validates the
    §5 ContactTemplate shape, preserves properties/variables unchanged, and
    refuses invalid shapes with a structured error before any persistence.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-ContactTemplate.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-contact-template.ps1'

    . $script:worker

    $script:properties = @{ displayName = 'Vendor'; externalAddress = 'vendor@example.invalid' }
    $script:variables = @{ region = 'eu'; tier = 'gold' }
}

Describe 'Invoke-ContactTemplate worker (T-0446)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-ContactTemplate -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-ContactTemplateIssues -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ContactTemplateJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the §5 template fields' {
            Get-ContactTemplateFields | Should -Be @('id', 'name', 'properties', 'variables')
        }

        It 'opens no tenant session and evaluates no strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Invoke-MgGraphRequest'
            $source | Should -Not -Match 'Connect-WorkerTenant'
            $source | Should -Not -Match 'Invoke-Expression'
            $source | Should -Not -Match 'New-MailContact|Set-MailContact'
        }

        It 'never persists template data to disk, logs, or transcripts' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
        }
    }

    Context 'shape validation' {
        It 'accepts a well-formed template with no issues' {
            Get-ContactTemplateIssues -Name 'Vendor' -Properties $script:properties -Variables $script:variables | Should -HaveCount 0
        }

        It 'accepts a template with no variables' {
            Get-ContactTemplateIssues -Name 'Vendor' -Properties $script:properties | Should -HaveCount 0
        }

        It 'reports a missing name, non-object properties, and non-object variables together' {
            $issues = Get-ContactTemplateIssues -Name '' -Properties @('a', 'b') -Variables 'nope'
            $fields = @($issues | ForEach-Object { $_.field })
            $fields | Should -Contain 'name'
            $fields | Should -Contain 'properties'
            $fields | Should -Contain 'variables'
        }
    }

    Context 'Invoke-ContactTemplate' {
        It 'returns the normalized template and preserves properties/variables unchanged' {
            $result = Invoke-ContactTemplate -TemplateId 'tpl-1' -Name '  Vendor  ' -Properties $script:properties -Variables $script:variables

            $result.id | Should -Be 'tpl-1'
            $result.name | Should -Be 'Vendor'
            $result.valid | Should -BeTrue
            $result.properties | Should -Be $script:properties
            $result.variables | Should -Be $script:variables
        }

        It 'defaults variables to an empty map' {
            $result = Invoke-ContactTemplate -Name 'Vendor' -Properties $script:properties
            $result.variables.Count | Should -Be 0
        }

        It 'refuses an invalid shape with a structured error and returns nothing' {
            { Invoke-ContactTemplate -Name 'Vendor' -Properties @('not', 'a', 'map') } | Should -Throw '*contact-template.invalid*'
            { Invoke-ContactTemplate -Name '' -Properties $script:properties } | Should -Throw '*name*'
            { Invoke-ContactTemplate -Name 'Vendor' -Properties $script:properties -Variables 'nope' } | Should -Throw '*variables*'
        }
    }

    Context 'job envelope' {
        It 'reads a template envelope' {
            $path = Join-Path $TestDrive 'template.json'
            @{
                schemaVersion = 'v1'
                payload       = @{ id = 'tpl-1'; name = 'Vendor'; properties = $script:properties; variables = $script:variables }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8

            $job = Read-ContactTemplateJob -Path $path

            $job['TemplateId'] | Should -Be 'tpl-1'
            $job['Name'] | Should -Be 'Vendor'
            $job['Properties'].displayName | Should -Be 'Vendor'
            $job['Variables'].region | Should -Be 'eu'
        }

        It 'rejects a missing file, a bad schema version, and an invalid shape' {
            { Read-ContactTemplateJob -Path (Join-Path $TestDrive 'no-such.json') } | Should -Throw

            $badVersion = Join-Path $TestDrive 'bad-version.json'
            @{ schemaVersion = 'v9'; payload = @{ name = 'Vendor'; properties = $script:properties } } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $badVersion -Encoding UTF8
            { Read-ContactTemplateJob -Path $badVersion } | Should -Throw

            $badShape = Join-Path $TestDrive 'bad-shape.json'
            @{ schemaVersion = 'v1'; payload = @{ name = 'Vendor'; properties = 'nope' } } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $badShape -Encoding UTF8
            { Read-ContactTemplateJob -Path $badShape } | Should -Throw '*contact-template.invalid*'
        }
    }

    Context 'entrypoint' {
        It 'validates a direct template and emits JSON on stdout' {
            $out = & $script:entrypoint -Name 'Vendor' -Properties $script:properties -Variables $script:variables | ConvertFrom-Json

            $out.name | Should -Be 'Vendor'
            $out.valid | Should -BeTrue
            $out.properties.displayName | Should -Be 'Vendor'
            $out.variables.region | Should -Be 'eu'
        }

        It 'refuses an invalid direct template' {
            { & $script:entrypoint -Name 'Vendor' -Properties 'nope' } | Should -Throw '*contact-template.invalid*'
        }

        It 'reads a job envelope and emits the normalized template' {
            $path = Join-Path $TestDrive 'entry-job.json'
            @{
                schemaVersion = 'v1'
                payload       = @{ id = 'tpl-2'; name = 'Vendor'; properties = $script:properties; variables = $script:variables }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8

            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json

            $out.id | Should -Be 'tpl-2'
            $out.properties.externalAddress | Should -Be 'vendor@example.invalid'
        }
    }
}
