BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-AutopilotProfile.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-autopilot-profile.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:G1 = 'aaaaaaaa-0000-0000-0000-000000000001'
    $script:G2 = 'aaaaaaaa-0000-0000-0000-000000000002'
    $script:G3 = 'aaaaaaaa-0000-0000-0000-000000000003'
    $script:profileBody = @{
        '@odata.type'      = '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile'
        displayName        = 'Standard user'
        deviceNameTemplate = 'CORP-%SERIAL%'
    }

    function script:Invoke-FakeProfileGraph {
        param($Method, $Uri, $Body)
        $script:graph.Add(@{ Method = $Method; Uri = $Uri; Body = $Body })
        switch -Regex ("$Method $Uri") {
            '^GET .*windowsAutopilotDeploymentProfiles\?\$filter=' {
                if ([uri]::UnescapeDataString($Uri) -like "*'Existing profile'*") { return @{ value = @(@{ id = 'p-old'; displayName = 'Existing profile' }) } }
                return @{ value = @() }
            }
            '^GET .*/p1\?\$expand=assignments$' {
                return @{
                    '@odata.type'      = '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile'
                    id                 = 'p1'
                    displayName        = 'Standard user'
                    deviceNameTemplate = 'CORP-%SERIAL%'
                    createdDateTime    = '2026-01-01T00:00:00Z'
                    assignments        = $script:assignments
                }
            }
            '^GET ' { throw 'Response status code does not indicate success: NotFound (Not Found).' }
            '^POST .*windowsAutopilotDeploymentProfiles$' { return @{ id = 'p-new' } }
            '^POST .*/assignments$' { if (($Body | ConvertFrom-Json).target.groupId -eq $script:G3) { throw 'BadRequest: group not found' }; return @{ id = 'as-new' } }
            default { return $null }
        }
    }
}

Describe 'Set-AutopilotProfile worker (T-0845)' {
    BeforeEach {
        $script:graph = [System.Collections.Generic.List[object]]::new()
        $script:assignments = @(@{ id = 'as-1'; target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $script:G1 } })
        Mock Invoke-MgGraphRequest { param($Method, $Uri, $Body) Invoke-FakeProfileGraph -Method $Method -Uri $Uri -Body $Body }
    }

    Context 'Create' {
        It 'previews a create without writing' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action create -ProfileBody $script:profileBody -Preview
            $res.preview | Should -BeTrue
            $res.plan.after.displayName | Should -Be 'Standard user'
            @($script:graph | Where-Object Method -ne 'GET').Count | Should -Be 0
        }

        It 'creates the profile and audits it' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action create -ProfileBody ($script:profileBody + @{ id = 'ignored' }) -Actor 'op' -Confirm:$false
            $res.profileId | Should -Be 'p-new'
            $post = $script:graph | Where-Object Method -eq 'POST'
            ($post.Body | ConvertFrom-Json).PSObject.Properties.Name | Should -Not -Contain 'id'
            $res.auditEvent.action | Should -Be 'intune.autopilot.profile.create'
            $res.auditEvent.actor | Should -Be 'op'
            $res.auditEvent.before | Should -BeNullOrEmpty
        }

        It 'refuses a name that already exists in the tenant' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action create -ProfileBody @{ displayName = 'Existing profile' } -Preview
            $res.statusCode | Should -Be 409
            $res.message | Should -BeLike '*p-old*'
        }
    }

    Context 'Update and delete' {
        It 'patches with the live @odata.type and before/after' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action update -ProfileId 'p1' -ProfileBody @{ deviceNameTemplate = 'LAP-%RAND:5%' } -Confirm:$false
            $patch = ($script:graph | Where-Object Method -eq 'PATCH').Body | ConvertFrom-Json
            $patch.'@odata.type' | Should -Be '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile'
            $patch.deviceNameTemplate | Should -Be 'LAP-%RAND:5%'
            $res.auditEvent.before.deviceNameTemplate | Should -Be 'CORP-%SERIAL%'
            $res.auditEvent.after.deviceNameTemplate | Should -Be 'LAP-%RAND:5%'
            $res.auditEvent.before.Keys | Should -Not -Contain 'createdDateTime'
        }

        It 'refuses to delete an assigned profile' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action delete -ProfileId 'p1' -ConfirmName 'Standard user' -Confirm:$false
            $res.statusCode | Should -Be 409
            $res.plan.assignmentCount | Should -Be 1
            @($script:graph | Where-Object Method -eq 'DELETE').Count | Should -Be 0
        }

        It 'deletes an unassigned profile only with the typed name' {
            $script:assignments = @()
            (Invoke-AutopilotProfileWrite -TenantId 't' -Action delete -ProfileId 'p1' -ConfirmName 'standard user' -Confirm:$false).error | Should -Be 'autopilot.profile.confirmation_required'
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action delete -ProfileId 'p1' -ConfirmName 'Standard user' -Confirm:$false
            ($script:graph | Where-Object Method -eq 'DELETE').Uri | Should -Be '/beta/deviceManagement/windowsAutopilotDeploymentProfiles/p1'
            $res.auditEvent.result | Should -Be 'success'
        }

        It 'returns 404 for a missing profile' {
            (Invoke-AutopilotProfileWrite -TenantId 't' -Action update -ProfileId 'gone' -ProfileBody @{ a = 1 } -Preview).statusCode | Should -Be 404
        }
    }

    Context 'Assign' {
        It 'plans adds and removes against the current assignments, skipping ones already in place' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action assign -ProfileId 'p1' -AddGroupIds @($script:G1, $script:G2) -RemoveGroupIds @($script:G1) -Preview
            @($res.plan.steps | ForEach-Object { "$($_.step):$($_.groupId)" }) | Should -Be @("add:$($script:G2)", "remove:$($script:G1)")
            @($res.plan.after.groupIds) | Should -Be @($script:G2)
        }

        It 'applies each step with its own result and reports a partial failure' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action assign -ProfileId 'p1' -AddGroupIds @($script:G2, $script:G3) -Confirm:$false
            @($res.steps.status) | Should -Be @('succeeded', 'failed')
            $res.steps[1].error | Should -BeLike '*group not found*'
            $res.auditEvent.result | Should -Be 'partial'
            $res.applied | Should -BeTrue
        }

        It 'removes by assignment id' {
            $null = Invoke-AutopilotProfileWrite -TenantId 't' -Action assign -ProfileId 'p1' -RemoveGroupIds @($script:G1) -Confirm:$false
            ($script:graph | Where-Object Method -eq 'DELETE').Uri | Should -Be '/beta/deviceManagement/windowsAutopilotDeploymentProfiles/p1/assignments/as-1'
        }

        It 'does nothing when every requested change is already in place, and rejects a non-GUID' {
            $res = Invoke-AutopilotProfileWrite -TenantId 't' -Action assign -ProfileId 'p1' -AddGroupIds @($script:G1) -Confirm:$false
            $res.applied | Should -BeFalse
            $res.auditEvent | Should -BeNullOrEmpty
            (Invoke-AutopilotProfileWrite -TenantId 't' -Action assign -ProfileId 'p1' -AddGroupIds @('Sales') -Preview).statusCode | Should -Be 400
        }
    }

    Context 'Entrypoint' {
        It 'runs a job document' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest { @{ value = @() } }
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; action = 'create'; preview = $true; profile = $script:profileBody } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.plan.after.displayName | Should -Be 'Standard user'
        }

        It 'rejects an unknown action' {
            $path = Join-Path $TestDrive 'bad.json'
            @{ tenantId = 't'; action = 'wipe' } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-AutopilotProfileJob -Path $path } | Should -Throw '*unknown action*'
        }
    }
}
