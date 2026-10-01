# Invoke-AlertEvaluation.Tests.ps1
# Pester tests for T-0564 — batched per-tenant alert evaluation with dry-run and
# sandboxed script mode. Asserts: only enabled rules are evaluated; each distinct
# log source is fetched once for the batch; an AlertEvent is emitted only for a
# matching row; the §3.2 operator semantics hold; a matching script-mode rule is
# dispatched to the EPIC-007 sandbox and audited, and no script runs in process.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Invoke-AlertEvaluation' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
        $script:handler = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Invoke-AlertEvaluation.ps1'
        . $script:handler

        $script:Events = [System.Collections.Generic.List[object]]::new()
        $script:Audits = [System.Collections.Generic.List[object]]::new()
        $script:Fetches = [System.Collections.Generic.List[string]]::new()
        $script:Dispatches = [System.Collections.Generic.List[object]]::new()

        function New-TestRule {
            param(
                [Parameter(Mandatory)][string]$Id,
                [Parameter(Mandatory)][string]$Source,
                [Parameter()][object]$Conditions = @(),
                [Parameter()][bool]$Enabled = $true,
                [Parameter()][bool]$ScriptMode = $false,
                [Parameter()][object]$Actions = $null
            )
            $rule = [ordered]@{
                id         = $Id
                source     = $Source
                severity   = 'High'
                enabled    = $Enabled
                conditions = @($Conditions)
            }
            if ($ScriptMode) { $rule['scriptMode'] = $true }
            if ($null -ne $Actions) { $rule['actions'] = @($Actions) }
            return $rule
        }

        function New-Condition {
            param(
                [Parameter(Mandatory)][string]$Property,
                [Parameter(Mandatory)][string]$Operator,
                [Parameter()][object]$InputValue
            )
            return [ordered]@{ property = $Property; operator = $Operator; input = $InputValue }
        }

        $script:EmitSeam = { param($event) $script:Events.Add($event) | Out-Null }
        $script:AuditSeam = { param($event) $script:Audits.Add($event) | Out-Null }
    }

    BeforeEach {
        $script:Events.Clear()
        $script:Audits.Clear()
        $script:Fetches.Clear()
        $script:Dispatches.Clear()
    }

    It 'evaluates enabled rules and emits an AlertEvent only for a matching row' {
        $rules = @(
            New-TestRule -Id 'run-failed' -Source 'runs' -Conditions @(
                (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
            )
        )
        $reader = {
            param($source)
            return @(
                [ordered]@{ status = 'succeeded'; runId = 'r-1' },
                [ordered]@{ status = 'failed'; runId = 'r-2' }
            )
        }

        $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
            -ReadLogSource $reader -EmitEvent $script:EmitSeam

        $result.EvaluatedRules | Should -Be 1
        $result.MatchedRules | Should -Be 1
        $result.FiredEvents | Should -Be 1
        $script:Events.Count | Should -Be 1
        $script:Events[0].ruleId | Should -Be 'run-failed'
        $script:Events[0].tenantId | Should -Be 'tenant-1'
        $script:Events[0].state | Should -Be 'open'
        $script:Events[0].payload.runId | Should -Be 'r-2'
    }

    It 'emits nothing when no row matches' {
        $rules = @(
            New-TestRule -Id 'run-failed' -Source 'runs' -Conditions @(
                (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
            )
        )
        $reader = { param($source) @([ordered]@{ status = 'succeeded' }) }

        $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
            -ReadLogSource $reader -EmitEvent $script:EmitSeam

        $result.MatchedRules | Should -Be 0
        $result.FiredEvents | Should -Be 0
        $script:Events.Count | Should -Be 0
    }

    It 'queries each distinct log source once for the whole tenant batch' {
        $rules = @(
            New-TestRule -Id 'run-failed' -Source 'runs' -Conditions @(
                (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
            )
            New-TestRule -Id 'run-partial' -Source 'runs' -Conditions @(
                (New-Condition -Property 'status' -Operator 'eq' -InputValue 'partial')
            )
            New-TestRule -Id 'new-drift' -Source 'drift' -Conditions @(
                (New-Condition -Property 'kind' -Operator 'eq' -InputValue 'extra')
            )
        )
        $reader = {
            param($source)
            $script:Fetches.Add($source) | Out-Null
            if ($source -eq 'runs') {
                return @([ordered]@{ status = 'failed' }, [ordered]@{ status = 'partial' })
            }
            return @([ordered]@{ kind = 'extra' })
        }

        $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
            -ReadLogSource $reader -EmitEvent $script:EmitSeam

        $script:Fetches.Count | Should -Be 2
        @($script:Fetches | Sort-Object -Unique).Count | Should -Be 2
        $result.SourceFetchCount | Should -Be 2
        @($result.Sources | Sort-Object) | Should -Be @('drift', 'runs')
        $result.FiredEvents | Should -Be 3
    }

    It 'ignores disabled rules and never fetches their source' {
        $rules = @(
            New-TestRule -Id 'run-failed' -Source 'runs' -Enabled $false -Conditions @(
                (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
            )
        )
        $reader = { param($source) $script:Fetches.Add($source) | Out-Null; @() }

        $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
            -ReadLogSource $reader -EmitEvent $script:EmitSeam

        $result.EvaluatedRules | Should -Be 0
        $script:Fetches.Count | Should -Be 0
        $script:Events.Count | Should -Be 0
    }

    It 'rehydrates conditions supplied as a JSON string' {
        $rule = [ordered]@{
            id         = 'run-failed'
            source     = 'runs'
            severity   = 'High'
            enabled    = $true
            conditions = '[{"property":"status","operator":"eq","input":"failed"}]'
        }
        $reader = { param($source) @([ordered]@{ status = 'failed' }) }

        $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules @($rule) `
            -ReadLogSource $reader -EmitEvent $script:EmitSeam

        $result.FiredEvents | Should -Be 1
    }

    It 'evaluates every §3.2 operator against the row property bag' {
        $cases = @(
            @{ Operator = 'eq';       Value = 5;            Input = 5;                    Expected = $true },
            @{ Operator = 'eq';       Value = 6;            Input = 5;                    Expected = $false },
            @{ Operator = 'ne';       Value = 'a';          Input = 'b';                  Expected = $true },
            @{ Operator = 'like';     Value = 'Failed';     Input = 'fail%';              Expected = $true },
            @{ Operator = 'like';     Value = 'Succeeded';  Input = 'fail%';              Expected = $false },
            @{ Operator = 'match';    Value = 'run-123';    Input = '^run-\d+$';          Expected = $true },
            @{ Operator = 'gt';       Value = 10;           Input = 5;                    Expected = $true },
            @{ Operator = 'in';       Value = 'High';       Input = @('High', 'Critical'); Expected = $true },
            @{ Operator = 'in';       Value = 'Low';        Input = @('High', 'Critical'); Expected = $false },
            @{ Operator = 'contains'; Value = 'ext-forward'; Input = 'forward';          Expected = $true }
        )

        foreach ($case in $cases) {
            $rule = New-TestRule -Id 'op' -Source 's' -Conditions @(
                (New-Condition -Property 'value' -Operator $case.Operator -InputValue $case.Input)
            )
            $reader = { param($source) @([ordered]@{ value = $case.Value }) }

            $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules @($rule) `
                -ReadLogSource $reader -EmitEvent $script:EmitSeam

            $result.MatchedRules | Should -Be ([int]$case.Expected) -Because "$($case.Operator) on $($case.Value)"
        }
    }

    It 'matches a rule with an empty condition set vacuously, as T-0563 defines' {
        $rules = @(New-TestRule -Id 'no-conditions' -Source 'runs' -Conditions @())
        $reader = { param($source) @([ordered]@{ status = 'anything' }) }

        $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
            -ReadLogSource $reader -EmitEvent $script:EmitSeam

        $result.FiredEvents | Should -Be 1
    }

    It 'fails closed when the condition property is absent from the row' {
        $rules = @(
            New-TestRule -Id 'run-failed' -Source 'runs' -Conditions @(
                (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
            )
        )
        $reader = { param($source) @([ordered]@{ state = 'failed' }) }

        $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
            -ReadLogSource $reader -EmitEvent $script:EmitSeam

        $result.FiredEvents | Should -Be 0
    }

    Context 'script mode' {
        It 'dispatches a matching script-mode rule to the sandbox seam and audits it' {
            $rules = @(
                New-TestRule -Id 'scripted' -Source 'runs' -ScriptMode $true -Actions @(
                    [ordered]@{ kind = 'script'; scriptId = 'alert-script-1' }
                ) -Conditions @(
                    (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
                )
            )
            $reader = { param($source) @([ordered]@{ status = 'failed' }) }
            $dispatch = {
                param($rule, $action, $entry)
                $script:Dispatches.Add([PSCustomObject]@{ ruleId = $rule.id; scriptId = $action.scriptId }) | Out-Null
                return [PSCustomObject]@{ Success = $true }
            }

            $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
                -ReadLogSource $reader -EmitEvent $script:EmitSeam `
                -InvokeScriptMode $dispatch -WriteAudit $script:AuditSeam

            $result.Dispatched | Should -Be 1
            $script:Dispatches.Count | Should -Be 1
            $script:Dispatches[0].scriptId | Should -Be 'alert-script-1'
            $script:Audits.Count | Should -Be 1
            $script:Audits[0].action | Should -Be 'alert.script-mode'
            $script:Audits[0].sandboxed | Should -BeTrue
            $script:Audits[0].tenantId | Should -Be 'tenant-1'
        }

        It 'does not dispatch a script-mode rule whose conditions do not match' {
            $rules = @(
                New-TestRule -Id 'scripted' -Source 'runs' -ScriptMode $true -Actions @(
                    [ordered]@{ kind = 'script'; scriptId = 'alert-script-1' }
                ) -Conditions @(
                    (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
                )
            )
            $reader = { param($source) @([ordered]@{ status = 'succeeded' }) }
            $dispatch = { param($rule, $action, $entry) $script:Dispatches.Add($rule.id) | Out-Null }

            $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
                -ReadLogSource $reader -EmitEvent $script:EmitSeam `
                -InvokeScriptMode $dispatch -WriteAudit $script:AuditSeam

            $result.Dispatched | Should -Be 0
            $script:Dispatches.Count | Should -Be 0
            $script:Audits.Count | Should -Be 0
        }

        It 'never evaluates script text in process and dispatches to the EPIC-007 sandbox' {
            $source = Get-Content -LiteralPath $script:handler -Raw
            $source | Should -Not -Match 'Invoke-Expression'
            $source | Should -Match 'Invoke-SandboxedScript'

            $rules = @(
                New-TestRule -Id 'scripted' -Source 'runs' -ScriptMode $true -Actions @(
                    [ordered]@{ kind = 'script'; scriptId = 'alert-script-2'; scriptContent = "Write-Output 'alert-sandbox-7'" }
                ) -Conditions @(
                    (New-Condition -Property 'status' -Operator 'eq' -InputValue 'failed')
                )
            )
            $reader = { param($source) @([ordered]@{ status = 'failed' }) }

            $result = Invoke-AlertEvaluation -TenantId 'tenant-1' -Rules $rules `
                -ReadLogSource $reader -EmitEvent $script:EmitSeam -WriteAudit $script:AuditSeam

            $result.Dispatched | Should -Be 1
            $script:Audits.Count | Should -Be 1
        }
    }
}
