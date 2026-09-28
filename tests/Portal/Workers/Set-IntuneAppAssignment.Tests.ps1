BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-IntuneAppAssignment.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-intune-app-assignment.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:G1 = '11111111-aaaa-bbbb-cccc-000000000001'
    $script:G2 = '11111111-aaaa-bbbb-cccc-000000000002'
    $script:G3 = '11111111-aaaa-bbbb-cccc-000000000003'
    $script:GX = '11111111-aaaa-bbbb-cccc-00000000000f'

    # The app starts with G1 required, All users available, and an exclusion for GX.
    function script:New-AppFixture {
        param([string]$Type = '#microsoft.graph.win32LobApp')
        @{
            '@odata.type' = $Type
            id            = 'app-1'
            displayName   = '7-Zip'
            assignments   = @(
                @{ id = 'a1'; intent = 'required'; target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $script:G1 } }
                @{ id = 'a2'; intent = 'available'; target = @{ '@odata.type' = '#microsoft.graph.allLicensedUsersAssignmentTarget' } }
                @{ id = 'a3'; intent = 'required'; target = @{ '@odata.type' = '#microsoft.graph.exclusionGroupAssignmentTarget'; groupId = $script:GX } }
            )
        }
    }
}

Describe 'Set-IntuneAppAssignment worker (T-0324)' {
    BeforeEach {
        $script:posts = [System.Collections.Generic.List[object]]::new()
        $script:appType = '#microsoft.graph.win32LobApp'
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            if ($Method -eq 'POST') { $script:posts.Add(@{ Uri = $Uri; Body = $Body }); return $null }
            if ($Uri -like '/beta/deviceAppManagement/mobileApps/app-1?*') { return (New-AppFixture -Type $script:appType) }
            if ($Uri -like '/beta/deviceAppManagement/mobileApps/*') { throw 'Response status code does not indicate success: NotFound (Not Found).' }
            if ($Uri -like "/v1.0/groups/$script:G3*") { throw 'Response status code does not indicate success: NotFound (Not Found).' }
            if ($Uri -like '/v1.0/groups/*') { return @{ id = 'g'; displayName = 'Pilot devices' } }
            throw "unexpected $Method $Uri"
        }
    }

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            Get-Command Set-IntuneAppAssignment -CommandType Function | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Plan preview' {
        It 'lists per-target changes against the current assignments without writing' {
            $req = @(
                @{ groupId = $script:G1; intent = 'uninstall' }
                @{ groupId = $script:G2; intent = 'required' }
                @{ target = 'allUsers'; intent = 'available' }
            )
            $res = Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Preview
            $res.preview | Should -BeTrue
            $script:posts.Count | Should -Be 0
            $plan = $res.plan
            $plan.appType | Should -Be 'win32'
            $plan.valid | Should -BeTrue
            $byKey = @{}; foreach ($c in $plan.changes) { $byKey[$c.key] = $c }
            $byKey["group:$script:G1"].change | Should -Be 'update'
            $byKey["group:$script:G1"].from | Should -Be 'required'
            $byKey["group:$script:G1"].to | Should -Be 'uninstall'
            $byKey["group:$script:G2"].change | Should -Be 'add'
            $byKey["group:$script:G2"].displayName | Should -Be 'Pilot devices'
            $byKey['allUsers'].change | Should -Be 'unchanged'
            $plan.planHash | Should -Match '^[0-9a-f]{64}$'
            @($plan.before).Count | Should -Be 3
        }

        It 'keeps unnamed targets in merge mode and removes them in replace mode, never touching exclusions' {
            $req = @(@{ groupId = $script:G2; intent = 'required' })
            $merge = (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Preview).plan
            @($merge.after.key | Sort-Object) | Should -Be @('allUsers', "exclude:$script:GX", "group:$script:G1", "group:$script:G2")
            @($merge.changes | Where-Object change -eq 'remove').Count | Should -Be 0

            $replace = (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Mode replace -Preview).plan
            @($replace.after.key | Sort-Object) | Should -Be @("exclude:$script:GX", "group:$script:G2")
            @($replace.changes | Where-Object change -eq 'remove' | ForEach-Object key | Sort-Object) | Should -Be @('allUsers', "group:$script:G1")
            $replace.planHash | Should -Not -Be $merge.planHash
        }

        It 'marks the plan invalid when a group does not exist' {
            $plan = (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments @(@{ groupId = $script:G3; intent = 'required' }) -Preview).plan
            $plan.valid | Should -BeFalse
            $plan.issues[0] | Should -BeLike "*$script:G3*does not exist*"
        }

        It 'rejects bad requests as validation errors' {
            foreach ($bad in @(
                    @(@{ groupId = $script:G1; intent = 'install' }),
                    @(@{ groupId = 'not-a-guid'; intent = 'required' }),
                    @(@{ target = 'everyone'; intent = 'required' }),
                    @(@{ target = 'allDevices'; intent = 'available' }),
                    @(@{ groupId = $script:G1; intent = 'required' }, @{ groupId = $script:G1; intent = 'uninstall' })
                )) {
                $res = Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $bad -Preview
                $res.statusCode | Should -Be 400
            }
        }

        It 'returns 404 for a missing app and 501 for an app type outside the registry' {
            (Set-IntuneAppAssignment -TenantId 't' -AppId 'gone' -Preview).statusCode | Should -Be 404
            $script:appType = '#microsoft.graph.officeSuiteApp'
            $res = Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Preview
            $res.statusCode | Should -Be 501
            $res.error | Should -Be 'intune.app-type.unsupported'
        }
    }

    Context 'Apply' {
        It 'posts the full after-set once and audits each change with actor and result' {
            $req = @(@{ groupId = $script:G1; intent = 'uninstall' }, @{ groupId = $script:G2; intent = 'required' })
            $hash = (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Preview).plan.planHash
            $res = Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -ConfirmPlan $hash -Actor 'operator-1' -Confirm:$false
            $res.applied | Should -BeTrue
            $script:posts.Count | Should -Be 1
            $script:posts[0].Uri | Should -Be '/beta/deviceAppManagement/mobileApps/app-1/assign'
            $sent = ($script:posts[0].Body | ConvertFrom-Json).mobileAppAssignments
            $sent.Count | Should -Be 4
            ($sent | Where-Object { $_.target.groupId -eq $script:G1 }).intent | Should -Be 'uninstall'
            ($sent | Where-Object { $_.target.'@odata.type' -eq '#microsoft.graph.exclusionGroupAssignmentTarget' }).target.groupId | Should -Be $script:GX

            @($res.auditEvents.action | Sort-Object) | Should -Be @('intune.app.assignment.add', 'intune.app.assignment.update')
            $update = $res.auditEvents | Where-Object action -eq 'intune.app.assignment.update'
            $update.actor | Should -Be 'operator-1'
            $update.result | Should -Be 'succeeded'
            $update.before.intent | Should -Be 'required'
            $update.after.intent | Should -Be 'uninstall'
        }

        It 'refuses to apply without the hash of the current plan' {
            $req = @(@{ groupId = $script:G2; intent = 'required' })
            (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Confirm:$false).statusCode | Should -Be 409
            (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -ConfirmPlan ('0' * 64) -Confirm:$false).error | Should -Be 'intune.app.assign.plan_changed'
            $script:posts.Count | Should -Be 0
        }

        It 'refuses to apply an invalid plan' {
            $req = @(@{ groupId = $script:G3; intent = 'required' })
            $hash = (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Preview).plan.planHash
            (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -ConfirmPlan $hash -Confirm:$false).statusCode | Should -Be 422
            $script:posts.Count | Should -Be 0
        }

        It 'writes nothing when every target is unchanged' {
            $req = @(@{ groupId = $script:G1; intent = 'required' })
            $hash = (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Preview).plan.planHash
            $res = Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -ConfirmPlan $hash -Confirm:$false
            $res.applied | Should -BeFalse
            $script:posts.Count | Should -Be 0
            @($res.auditEvents).Count | Should -Be 0
        }

        It 'audits a failed Graph write with the failure' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Method -eq 'POST') { throw 'BadRequest: assignment rejected' }
                if ($Uri -like '/v1.0/groups/*') { return @{ displayName = 'G' } }
                return (New-AppFixture)
            }
            $req = @(@{ groupId = $script:G2; intent = 'required' })
            $hash = (Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -Preview).plan.planHash
            $res = Set-IntuneAppAssignment -TenantId 't' -AppId 'app-1' -Assignments $req -ConfirmPlan $hash -Confirm:$false
            $res.applied | Should -BeFalse
            $res.auditEvents[0].result | Should -Be 'failed'
            $res.auditEvents[0].error | Should -BeLike '*assignment rejected*'
        }
    }

    Context 'Entrypoint' {
        It 'reads the job and prints the preview as JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            $fixture = New-AppFixture
            Mock Invoke-MgGraphRequest { param($Method, $Uri) if ($Uri -like '/v1.0/groups/*') { @{ displayName = 'G' } } else { $fixture } }.GetNewClosure()
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; appId = 'app-1'; preview = $true; assignments = @(@{ groupId = $script:G2; intent = 'required' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.preview | Should -BeTrue
            ($out.plan.changes | Where-Object change -eq 'add').groupId | Should -Be $script:G2
        }

        It 'rejects an unknown mode in the job' {
            $path = Join-Path $TestDrive 'bad.json'
            @{ tenantId = 't'; appId = 'a'; mode = 'overwrite' } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-IntuneAppAssignmentJob -Path $path } | Should -Throw '*unknown mode*'
        }
    }
}
