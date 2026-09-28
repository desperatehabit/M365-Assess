BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Import-AutopilotDevices.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/import-autopilot-devices.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:hash = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('hardware-hash'))
    $script:devices = @(
        @{ id = 'ap-1'; serialNumber = 'SER-001'; groupTag = 'Sales'; model = 'Surface Laptop 5'; manufacturer = 'Microsoft'; deploymentProfileAssignmentStatus = 'assignedInSync'; enrollmentState = 'enrolled' }
        @{ id = 'ap-2'; serialNumber = 'SER-002'; groupTag = 'Kiosk'; model = 'OptiPlex'; manufacturer = 'Dell'; deploymentProfileAssignmentStatus = 'notAssigned'; enrollmentState = 'notContacted' }
        @{ id = 'ap-3'; serialNumber = 'SER-003'; groupTag = $null; model = 'ThinkPad'; manufacturer = 'Lenovo'; deploymentProfileAssignmentStatus = 'assignedUnkownSyncState'; enrollmentState = 'enrolled' }
    )

    # Graph fake: device lists, pending imports, corporate identifiers, and the two import actions.
    function script:Invoke-FakeGraph {
        param($Method, $Uri, $Body)
        $script:graph.Add(@{ Method = $Method; Uri = $Uri; Body = $Body })
        switch -Regex ("$Method $Uri") {
            '^GET /v1.0/deviceManagement/windowsAutopilotDeviceIdentities$' { return @{ value = $script:devices } }
            '^GET /v1.0/deviceManagement/importedWindowsAutopilotDeviceIdentities$' { return @{ value = @(@{ serialNumber = 'SER-PENDING' }) } }
            '^GET /beta/deviceManagement/importedDeviceIdentities$' { return @{ value = @(@{ importedDeviceIdentifier = 'Dell,OptiPlex,PREP-OLD' }) } }
            '^POST .*/importedWindowsAutopilotDeviceIdentities/import$' {
                $sent = ($Body | ConvertFrom-Json).importedWindowsAutopilotDeviceIdentities
                return @{ value = @($sent | ForEach-Object {
                            $status = if ($_.serialNumber -eq 'NEW-BAD') { 'error' } else { 'pending' }
                            @{ serialNumber = $_.serialNumber; state = @{ deviceImportStatus = $status; deviceErrorCode = 806; deviceErrorName = 'ZtdDeviceAlreadyAssigned' } }
                        }) }
            }
            '^POST .*/importDeviceIdentityList$' {
                $sent = ($Body | ConvertFrom-Json).importedDeviceIdentities
                return @{ value = @($sent | ForEach-Object { @{ importedDeviceIdentifier = $_.importedDeviceIdentifier } }) }
            }
            default { throw "unexpected $Method $Uri" }
        }
    }
}

Describe 'Import-AutopilotDevices worker (T-0328)' {
    BeforeEach {
        $script:graph = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-MgGraphRequest { param($Method, $Uri, $Body) Invoke-FakeGraph -Method $Method -Uri $Uri -Body $Body }
    }

    Context 'Devices' {
        It 'lists devices with serial, group tag, profile status, and enrollment state' {
            $res = Get-AutopilotDevices -TenantId 't'
            $res.totalCount | Should -Be 3
            $res.items[0].serialNumber | Should -Be 'SER-001'
            $res.items[0].groupTag | Should -Be 'Sales'
            $res.items[0].profileStatus | Should -Be 'assignedInSync'
            $res.items[0].enrollmentState | Should -Be 'enrolled'
            $res.items[2].groupTag | Should -BeNullOrEmpty
        }

        It 'filters by group tag, enrollment state, and search, and pages' {
            (Get-AutopilotDevices -TenantId 't' -GroupTag 'kiosk').items.id | Should -Be 'ap-2'
            @((Get-AutopilotDevices -TenantId 't' -EnrollmentState 'enrolled').items.id) | Should -Be @('ap-1', 'ap-3')
            (Get-AutopilotDevices -TenantId 't' -Search 'thinkpad').items.id | Should -Be 'ap-3'
            $page = Get-AutopilotDevices -TenantId 't' -Top 2
            $page.nextCursor | Should -Be '2'
            (Get-AutopilotDevices -TenantId 't' -Top 2 -Cursor '2').items.id | Should -Be 'ap-3'
        }

        It 'reads one device with its profile name, or null when missing' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*/ap-1?$expand=deploymentProfile') { return @{ id = 'ap-1'; serialNumber = 'SER-001'; deploymentProfile = @{ displayName = 'Standard user' } } }
                throw 'Response status code does not indicate success: NotFound (Not Found).'
            }
            (Get-AutopilotDevice -DeviceId 'ap-1').profileName | Should -Be 'Standard user'
            Get-AutopilotDevice -DeviceId 'gone' | Should -BeNullOrEmpty
        }

        It 'lists deployment profiles read-only' {
            Mock Invoke-MgGraphRequest { @{ value = @(@{ '@odata.type' = '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile'; id = 'p1'; displayName = 'Standard user'; deviceNameTemplate = 'CORP-%SERIAL%' }) } }
            $res = Get-AutopilotProfiles -TenantId 't'
            $res.items[0].profileType | Should -Be 'azureADWindowsAutopilotDeploymentProfile'
            $res.items[0].deviceNameTemplate | Should -Be 'CORP-%SERIAL%'
        }
    }

    Context 'Manual import' {
        It 'previews per-row results, flagging batch and tenant duplicates and invalid rows, without writing' {
            $rows = @(
                @{ serialNumber = 'NEW-1'; hardwareHash = $script:hash; groupTag = 'Sales' }
                @{ serialNumber = 'new-1'; hardwareHash = $script:hash }
                @{ serialNumber = 'SER-002'; hardwareHash = $script:hash }
                @{ serialNumber = 'SER-PENDING'; hardwareHash = $script:hash }
                @{ serialNumber = 'NEW-2'; hardwareHash = 'not base64!' }
                @{ serialNumber = ''; hardwareHash = $script:hash }
            )
            $res = Invoke-AutopilotImport -TenantId 't' -Source manual -Rows $rows -Preview
            @($res.rows.status) | Should -Be @('ready', 'duplicate', 'duplicate', 'duplicate', 'invalid', 'invalid')
            $res.rows[1].reason | Should -Be 'serial number appears earlier in this import'
            $res.rows[2].reason | Should -Be 'serial number is already registered in the tenant'
            $res.rows[4].reason | Should -Be 'hardware hash is not valid base64'
            $res.counts.ready | Should -Be 1
            @($script:graph | Where-Object Method -eq 'POST').Count | Should -Be 0
        }

        It 'imports only new valid rows and reports each row, including a Graph import error' {
            $rows = @(
                @{ serialNumber = 'NEW-1'; hardwareHash = $script:hash; groupTag = 'Sales'; assignedUser = 'user@contoso.com' }
                @{ serialNumber = 'SER-001'; hardwareHash = $script:hash }
                @{ serialNumber = 'NEW-BAD'; hardwareHash = $script:hash }
            )
            $res = Invoke-AutopilotImport -TenantId 't' -Source manual -Rows $rows -Actor 'op' -Confirm:$false
            @($res.rows.status) | Should -Be @('imported', 'duplicate', 'failed')
            $res.rows[0].reason | Should -Be 'import pending'
            $res.rows[2].reason | Should -BeLike '*806*ZtdDeviceAlreadyAssigned*'
            $post = $script:graph | Where-Object Method -eq 'POST'
            $sent = ($post.Body | ConvertFrom-Json).importedWindowsAutopilotDeviceIdentities
            @($sent.serialNumber) | Should -Be @('NEW-1', 'NEW-BAD')
            $sent[0].assignedUserPrincipalName | Should -Be 'user@contoso.com'
            $sent[0].groupTag | Should -Be 'Sales'
            $res.counts | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'intune.autopilot.import'
            $res.auditEvent.actor | Should -Be 'op'
            $res.auditEvent.result | Should -Be 'partial'
            @($res.auditEvent.after.serials) | Should -Be @('NEW-1', 'NEW-BAD')
        }

        It 'marks every sent row failed when Graph rejects the batch' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Method -eq 'POST') { throw 'BadRequest' }
                return @{ value = @() }
            }
            $res = Invoke-AutopilotImport -TenantId 't' -Source manual -Rows @(@{ serialNumber = 'A'; hardwareHash = $script:hash }) -Confirm:$false
            $res.rows[0].status | Should -Be 'failed'
            $res.auditEvent.result | Should -Be 'failure'
        }

        It 'writes nothing and emits no audit when every row is a duplicate' {
            $res = Invoke-AutopilotImport -TenantId 't' -Source manual -Rows @(@{ serialNumber = 'SER-001'; hardwareHash = $script:hash }) -Confirm:$false
            $res.rows[0].status | Should -Be 'duplicate'
            $res.auditEvent | Should -BeNullOrEmpty
            @($script:graph | Where-Object Method -eq 'POST').Count | Should -Be 0
        }

        It 'rejects an empty or oversized batch' {
            (Invoke-AutopilotImport -TenantId 't' -Source manual -Rows @() -Preview).statusCode | Should -Be 400
            $many = 1..501 | ForEach-Object { @{ serialNumber = "S$_"; hardwareHash = $script:hash } }
            (Invoke-AutopilotImport -TenantId 't' -Source manual -Rows $many -Preview).message | Should -BeLike '*at most 500*'
        }
    }

    Context 'CSV import' {
        It 'parses Get-WindowsAutoPilotInfo output' {
            $csv = "Device Serial Number,Windows Product ID,Hardware Hash,Group Tag`nCSV-1,,$($script:hash),Kiosk`nSER-001,,$($script:hash),"
            $res = Invoke-AutopilotImport -TenantId 't' -Source csv -Csv $csv -Preview
            @($res.rows.serialNumber) | Should -Be @('CSV-1', 'SER-001')
            @($res.rows.status) | Should -Be @('ready', 'duplicate')
        }

        It 'rejects a CSV without the required columns' {
            $res = Invoke-AutopilotImport -TenantId 't' -Source csv -Csv "Serial,Hash`nA,B" -Preview
            $res.statusCode | Should -Be 400
            $res.message | Should -BeLike "*Device Serial Number*"
        }
    }

    Context 'Device-prep import' {
        It 'sends manufacturer,model,serial corporate identifiers and flags existing ones' {
            $rows = @(
                @{ manufacturer = 'Dell'; model = 'OptiPlex'; serialNumber = 'PREP-1' }
                @{ manufacturer = 'Dell'; model = 'OptiPlex'; serialNumber = 'PREP-OLD' }
                @{ manufacturer = 'Dell,Inc'; model = 'X'; serialNumber = 'PREP-2' }
            )
            $res = Invoke-AutopilotImport -TenantId 't' -Source device-prep -Rows $rows -Confirm:$false
            @($res.rows.status) | Should -Be @('imported', 'duplicate', 'invalid')
            $res.rows[2].reason | Should -Be 'manufacturer must not contain a comma'
            $sent = (($script:graph | Where-Object Method -eq 'POST').Body | ConvertFrom-Json)
            $sent.overwriteImportedDeviceIdentities | Should -BeFalse
            $sent.importedDeviceIdentities[0].importedDeviceIdentifier | Should -Be 'Dell,OptiPlex,PREP-1'
            $sent.importedDeviceIdentities[0].importedDeviceIdentityType | Should -Be 'manufacturerModelSerial'
        }
    }

    Context 'Entrypoint' {
        It 'dispatches the job action and prints JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            $fixture = $script:devices
            Mock Invoke-MgGraphRequest { @{ value = $fixture } }.GetNewClosure()
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; action = 'list-devices'; groupTag = 'Sales' } | ConvertTo-Json | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.items[0].id | Should -Be 'ap-1'
        }

        It 'reports a missing device as a structured 404' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest { throw 'NotFound' }
            $path = Join-Path $TestDrive 'get.json'
            @{ tenantId = 't'; action = 'get-device'; deviceId = 'x' } | ConvertTo-Json | Set-Content -LiteralPath $path
            (& $script:entrypoint -JobFile $path | ConvertFrom-Json).statusCode | Should -Be 404
        }

        It 'rejects an unknown action' {
            $path = Join-Path $TestDrive 'bad.json'
            @{ tenantId = 't'; action = 'wipe' } | ConvertTo-Json | Set-Content -LiteralPath $path
            { Read-AutopilotJob -Path $path } | Should -Throw '*unknown action*'
        }
    }
}
