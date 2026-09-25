BeforeAll {
    $script:moduleRoot   = (Resolve-Path (Join-Path $PSScriptRoot '../../src/M365-Assess')).Path
    $script:entrypoint   = Join-Path $script:moduleRoot 'Remediate/Invoke-M365Remediation.ps1'
    $script:psm1         = Join-Path $script:moduleRoot 'M365-Assess.psm1'

    . $script:entrypoint
}

Describe 'Invoke-M365Remediation scaffold (T-0101)' {

    Context 'module placement' {
        It 'ships as a file under the new Remediate folder' {
            $script:entrypoint | Should -Exist
        }

        It 'is dot-sourced by the module loader' {
            $psm1Body = Get-Content -Path $script:psm1 -Raw
            $psm1Body | Should -Match 'Remediate[\\/]Invoke-M365Remediation\.ps1'
        }

        It 'is exported when the module loads' {
            Import-Module $script:psm1 -Force -ErrorAction Stop
            try {
                $module = Get-Module -Name M365-Assess -ErrorAction Stop
                $module.ExportedFunctions.Keys |
                    Should -Contain 'Invoke-M365Remediation'
            }
            finally {
                Remove-Module -Name M365-Assess -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'parameter surface' {
        It 'exposes the -Plan and -Apply switches' {
            $command = Get-Command -Name Invoke-M365Remediation
            $command.Parameters.Keys | Should -Contain 'Plan'
            $command.Parameters.Keys | Should -Contain 'Apply'
        }

        It 'supports ShouldProcess (-WhatIf / -Confirm)' {
            $command = Get-Command -Name Invoke-M365Remediation
            $command.Parameters.Keys | Should -Contain 'WhatIf'
            $command.Parameters.Keys | Should -Contain 'Confirm'
        }
    }

    Context 'not-implemented body' {
        It 'raises NotImplementedException for -Plan' {
            { Invoke-M365Remediation -Plan } | Should -Throw '*not implemented*'
        }

        It 'raises NotImplementedException for -Apply' {
            { Invoke-M365Remediation -Apply -Confirm:$false } | Should -Throw '*not implemented*'
        }
    }
}
