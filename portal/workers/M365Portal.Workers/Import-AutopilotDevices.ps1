# Import-AutopilotDevices.ps1 - EPIC-017 Autopilot worker (SPEC section 3.4, section 4.3; T-0328).
#
# Actions (job field 'action'):
#   list-devices  - GET windowsAutopilotDeviceIdentities: serial, group tag, profile status,
#                   enrollment state; filtered and paged here.
#   get-device    - one device with its assigned deployment profile.
#   list-profiles - GET windowsAutopilotDeploymentProfiles (read-only; profile writes are not here).
#   import        - add devices, previewed or applied, with a result for every input row:
#       manual      rows { serialNumber, hardwareHash, groupTag?, assignedUser?, productKey? }
#       csv         Get-WindowsAutoPilotInfo output ("Device Serial Number", "Windows Product ID",
#                   "Hardware Hash", optional "Group Tag" / "Assigned User")
#       device-prep rows { manufacturer, model, serialNumber } -> corporate identifiers
#                   (importedDeviceIdentities, manufacturerModelSerial)
#     Duplicates are detected within the batch and against the tenant's registered devices
#     (or corporate identifiers) and reported per row; only valid, new rows are sent to Graph.

$script:AutopilotV1 = '/v1.0/deviceManagement'
$script:AutopilotBeta = '/beta/deviceManagement'
$script:AutopilotMaxRows = 500

function Read-AutopilotJob {
    <#
    .SYNOPSIS
        Parses a job document for the Autopilot worker.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    if (-not $json['tenantId']) { throw "job envelope '$Path' is missing mandatory 'tenantId'" }
    $action = [string]$json['action']
    if (@('list-devices', 'get-device', 'list-profiles', 'import') -notcontains $action) {
        throw "job envelope '$Path' has unknown action '$action'"
    }
    return $json
}

function Get-AutopilotValue {
    # Reads a property from a hashtable or a PSCustomObject.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Get-AutopilotCollection {
    <#
    .SYNOPSIS
        GETs a Graph collection and follows @odata.nextLink to the end.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([Parameter(Mandatory)][string]$Uri)

    $items = [System.Collections.Generic.List[object]]::new()
    $next = $Uri
    while ($next) {
        $response = Invoke-MgGraphRequest -Method GET -Uri $next
        foreach ($item in @(Get-AutopilotValue -Object $response -Name 'value')) { if ($null -ne $item) { $items.Add($item) } }
        $next = Get-AutopilotValue -Object $response -Name '@odata.nextLink'
    }
    return , $items.ToArray()
}

function ConvertTo-AutopilotDeviceRow {
    # Normalises a windowsAutopilotDeviceIdentity into the portal row shape.
    param([object]$Device)
    $assignedProfile = Get-AutopilotValue -Object $Device -Name 'deploymentProfile'
    $v = { param($n) $x = Get-AutopilotValue -Object $Device -Name $n; if ($null -eq $x -or $x -eq '') { $null } else { [string]$x } }
    return @{
        id                      = [string](Get-AutopilotValue -Object $Device -Name 'id')
        serialNumber            = & $v 'serialNumber'
        groupTag                = & $v 'groupTag'
        manufacturer            = & $v 'manufacturer'
        model                   = & $v 'model'
        profileStatus           = & $v 'deploymentProfileAssignmentStatus'
        profileName             = if ($assignedProfile) { [string](Get-AutopilotValue -Object $assignedProfile -Name 'displayName') } else { $null }
        enrollmentState         = & $v 'enrollmentState'
        lastContactedDateTime   = & $v 'lastContactedDateTime'
        assignedUser            = & $v 'userPrincipalName'
        purchaseOrderIdentifier = & $v 'purchaseOrderIdentifier'
    }
}

function Get-AutopilotDevices {
    <#
    .SYNOPSIS
        Lists a tenant's Autopilot devices with optional filters and offset paging.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [string]$Search = '',
        [string]$GroupTag = '',
        [string]$EnrollmentState = '',
        [int]$Top = 100,
        [string]$Cursor = ''
    )

    $rows = @(foreach ($d in (Get-AutopilotCollection -Uri "$script:AutopilotV1/windowsAutopilotDeviceIdentities")) { ConvertTo-AutopilotDeviceRow -Device $d })
    $rows = @($rows | Where-Object {
            (-not $GroupTag -or [string]$_.groupTag -ieq $GroupTag) -and
            (-not $EnrollmentState -or [string]$_.enrollmentState -ieq $EnrollmentState) -and
            (-not $Search -or ("$($_.serialNumber) $($_.groupTag) $($_.model)").IndexOf($Search, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
        })
    $offset = 0
    if ($Cursor -and -not [int]::TryParse($Cursor, [ref]$offset)) { throw "cursor '$Cursor' is not valid" }
    $size = [Math]::Max(1, $Top)
    return @{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($rows | Select-Object -Skip $offset -First $size)
        nextCursor = if ($offset + $size -lt $rows.Count) { [string]($offset + $size) } else { $null }
    }
}

function Get-AutopilotDevice {
    <#
    .SYNOPSIS
        Reads one Autopilot device with its deployment profile; $null when it does not exist.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$DeviceId)

    try {
        $device = Invoke-MgGraphRequest -Method GET -Uri "$script:AutopilotBeta/windowsAutopilotDeviceIdentities/$([uri]::EscapeDataString($DeviceId))?`$expand=deploymentProfile"
    }
    catch {
        if ($_.Exception.Message -match '404|NotFound|ResourceNotFound') { return $null }
        throw
    }
    return ConvertTo-AutopilotDeviceRow -Device $device
}

function Get-AutopilotProfiles {
    <#
    .SYNOPSIS
        Lists the tenant's Autopilot deployment profiles (read-only).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$TenantId)

    $items = @(foreach ($p in (Get-AutopilotCollection -Uri "$script:AutopilotBeta/windowsAutopilotDeploymentProfiles")) {
            @{
                id                   = [string](Get-AutopilotValue -Object $p -Name 'id')
                displayName          = [string](Get-AutopilotValue -Object $p -Name 'displayName')
                description          = [string](Get-AutopilotValue -Object $p -Name 'description')
                deviceNameTemplate   = [string](Get-AutopilotValue -Object $p -Name 'deviceNameTemplate')
                profileType          = ([string](Get-AutopilotValue -Object $p -Name '@odata.type')) -replace '#microsoft.graph.', ''
                lastModifiedDateTime = [string](Get-AutopilotValue -Object $p -Name 'lastModifiedDateTime')
            }
        })
    return @{ tenantId = $TenantId; totalCount = $items.Count; items = $items }
}

function ConvertFrom-AutopilotCsv {
    <#
    .SYNOPSIS
        Parses Get-WindowsAutoPilotInfo CSV text into manual import rows.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([Parameter(Mandatory)][string]$Csv)

    $records = @($Csv | ConvertFrom-Csv)
    if ($records.Count -gt 0) {
        $headers = $records[0].PSObject.Properties.Name
        foreach ($required in @('Device Serial Number', 'Hardware Hash')) {
            if ($headers -notcontains $required) { throw "CSV is missing the '$required' column" }
        }
    }
    return , @(foreach ($r in $records) {
            @{
                serialNumber = [string]$r.'Device Serial Number'
                productKey   = [string]$r.'Windows Product ID'
                hardwareHash = [string]$r.'Hardware Hash'
                groupTag     = [string]$r.'Group Tag'
                assignedUser = [string]$r.'Assigned User'
            }
        })
}

function Test-AutopilotImportRow {
    # Returns the reason a row is invalid, or $null.
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][object]$Row)
    $serial = [string](Get-AutopilotValue -Object $Row -Name 'serialNumber')
    if (-not $serial.Trim()) { return 'serial number is required' }
    if ($serial.Length -gt 128) { return 'serial number is too long' }
    $tag = [string](Get-AutopilotValue -Object $Row -Name 'groupTag')
    if ($tag.Length -gt 128) { return 'group tag is too long' }
    if ($Source -eq 'device-prep') {
        foreach ($f in @('manufacturer', 'model')) {
            $value = [string](Get-AutopilotValue -Object $Row -Name $f)
            if (-not $value.Trim()) { return "$f is required" }
            if ($value.Contains(',')) { return "$f must not contain a comma" }
        }
        if ($serial.Contains(',')) { return 'serial number must not contain a comma' }
        return $null
    }
    $hash = [string](Get-AutopilotValue -Object $Row -Name 'hardwareHash')
    if (-not $hash.Trim()) { return 'hardware hash is required' }
    try { $null = [Convert]::FromBase64String($hash.Trim()) } catch { return 'hardware hash is not valid base64' }
    return $null
}

function Invoke-AutopilotImport {
    <#
    .SYNOPSIS
        Previews or imports Autopilot devices, reporting every input row.
    .OUTPUTS
        @{ tenantId; source; preview; rows = @(@{ row; serialNumber; status; reason }); counts; auditEvent }
        Row status: ready (preview), imported, duplicate, invalid, failed.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][ValidateSet('manual', 'csv', 'device-prep')][string]$Source,
        [object[]]$Rows = @(),
        [string]$Csv = '',
        [switch]$Preview,
        [string]$Actor = 'system'
    )

    if ($Source -eq 'csv') {
        try { $Rows = ConvertFrom-AutopilotCsv -Csv $Csv }
        catch { return @{ error = 'request.validation_failed'; message = $_.Exception.Message; statusCode = 400 } }
    }
    if ($Rows.Count -eq 0) { return @{ error = 'request.validation_failed'; message = 'no device rows to import'; statusCode = 400 } }
    if ($Rows.Count -gt $script:AutopilotMaxRows) {
        return @{ error = 'request.validation_failed'; message = "at most $script:AutopilotMaxRows devices per import"; statusCode = 400 }
    }

    # Serials already known to the tenant.
    $known = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if ($Source -eq 'device-prep') {
        foreach ($i in (Get-AutopilotCollection -Uri "$script:AutopilotBeta/importedDeviceIdentities")) {
            $parts = ([string](Get-AutopilotValue -Object $i -Name 'importedDeviceIdentifier')).Split(',')
            if ($parts.Count -ge 3) { $null = $known.Add($parts[2].Trim()) }
        }
    }
    else {
        foreach ($d in (Get-AutopilotCollection -Uri "$script:AutopilotV1/windowsAutopilotDeviceIdentities")) {
            $null = $known.Add([string](Get-AutopilotValue -Object $d -Name 'serialNumber'))
        }
        foreach ($d in (Get-AutopilotCollection -Uri "$script:AutopilotV1/importedWindowsAutopilotDeviceIdentities")) {
            $null = $known.Add([string](Get-AutopilotValue -Object $d -Name 'serialNumber'))
        }
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $results = [System.Collections.Generic.List[hashtable]]::new()
    $toSend = [System.Collections.Generic.List[hashtable]]::new()
    for ($i = 0; $i -lt $Rows.Count; $i++) {
        $row = $Rows[$i]
        $serial = ([string](Get-AutopilotValue -Object $row -Name 'serialNumber')).Trim()
        $result = @{ row = $i + 1; serialNumber = $serial; status = 'ready'; reason = $null }
        $problem = Test-AutopilotImportRow -Source $Source -Row $row
        if ($problem) { $result.status = 'invalid'; $result.reason = $problem }
        elseif (-not $seen.Add($serial)) { $result.status = 'duplicate'; $result.reason = 'serial number appears earlier in this import' }
        elseif ($known.Contains($serial)) { $result.status = 'duplicate'; $result.reason = 'serial number is already registered in the tenant' }
        else { $toSend.Add(@{ result = $result; row = $row }) }
        $results.Add($result)
    }

    $count = { param($s) @($results | Where-Object { $_.status -eq $s }).Count }
    if ($Preview -or $toSend.Count -eq 0 -or -not $PSCmdlet.ShouldProcess($TenantId, "Import $($toSend.Count) Autopilot devices")) {
        return @{
            tenantId   = $TenantId
            source     = $Source
            preview    = [bool]$Preview
            rows       = @($results)
            counts     = @{ ready = & $count 'ready'; duplicate = & $count 'duplicate'; invalid = & $count 'invalid' }
            auditEvent = $null
        }
    }

    try {
        if ($Source -eq 'device-prep') {
            $body = @{
                overwriteImportedDeviceIdentities = $false
                importedDeviceIdentities          = @(foreach ($s in $toSend) {
                        @{
                            importedDeviceIdentifier   = "$(([string](Get-AutopilotValue -Object $s.row -Name 'manufacturer')).Trim()),$(([string](Get-AutopilotValue -Object $s.row -Name 'model')).Trim()),$($s.result.serialNumber)"
                            importedDeviceIdentityType = 'manufacturerModelSerial'
                        }
                    })
            }
            $response = Invoke-MgGraphRequest -Method POST -Uri "$script:AutopilotBeta/importedDeviceIdentities/importDeviceIdentityList" -Body ($body | ConvertTo-Json -Depth 5 -Compress)
            $returned = @(Get-AutopilotValue -Object $response -Name 'value')
            foreach ($s in $toSend) {
                $match = $returned | Where-Object { ([string](Get-AutopilotValue -Object $_ -Name 'importedDeviceIdentifier')).EndsWith(",$($s.result.serialNumber)") } | Select-Object -First 1
                if ($match) { $s.result.status = 'imported' }
                elseif ($returned.Count -eq 0) { $s.result.status = 'imported'; $s.result.reason = 'accepted; Graph returned no per-identifier confirmation' }
                else { $s.result.status = 'failed'; $s.result.reason = 'Graph did not accept this identifier' }
            }
        }
        else {
            $body = @{
                importedWindowsAutopilotDeviceIdentities = @(foreach ($s in $toSend) {
                        $entry = @{
                            '@odata.type'      = '#microsoft.graph.importedWindowsAutopilotDeviceIdentity'
                            serialNumber       = $s.result.serialNumber
                            hardwareIdentifier = ([string](Get-AutopilotValue -Object $s.row -Name 'hardwareHash')).Trim()
                        }
                        foreach ($pair in @(@('groupTag', 'groupTag'), @('productKey', 'productKey'), @('assignedUser', 'assignedUserPrincipalName'))) {
                            $value = ([string](Get-AutopilotValue -Object $s.row -Name $pair[0])).Trim()
                            if ($value) { $entry[$pair[1]] = $value }
                        }
                        $entry
                    })
            }
            $response = Invoke-MgGraphRequest -Method POST -Uri "$script:AutopilotV1/importedWindowsAutopilotDeviceIdentities/import" -Body ($body | ConvertTo-Json -Depth 5 -Compress)
            $returned = @(Get-AutopilotValue -Object $response -Name 'value')
            foreach ($s in $toSend) {
                $match = $returned | Where-Object { [string](Get-AutopilotValue -Object $_ -Name 'serialNumber') -ieq $s.result.serialNumber } | Select-Object -First 1
                $state = Get-AutopilotValue -Object $match -Name 'state'
                $importStatus = [string](Get-AutopilotValue -Object $state -Name 'deviceImportStatus')
                if ($importStatus -eq 'error') {
                    $s.result.status = 'failed'
                    $s.result.reason = "Graph import error $(Get-AutopilotValue -Object $state -Name 'deviceErrorCode'): $(Get-AutopilotValue -Object $state -Name 'deviceErrorName')"
                }
                else {
                    $s.result.status = 'imported'
                    $s.result.reason = if ($importStatus -and $importStatus -ne 'complete') { "import $importStatus" } else { $null }
                }
            }
        }
    }
    catch {
        foreach ($s in $toSend) { $s.result.status = 'failed'; $s.result.reason = $_.ToString() }
    }

    $counts = @{ imported = & $count 'imported'; duplicate = & $count 'duplicate'; invalid = & $count 'invalid'; failed = & $count 'failed' }
    return @{
        tenantId   = $TenantId
        source     = $Source
        preview    = $false
        rows       = @($results)
        counts     = $counts
        auditEvent = @{
            id        = [guid]::NewGuid().ToString()
            tenantId  = $TenantId
            action    = 'intune.autopilot.import'
            targetId  = $TenantId
            actor     = $Actor
            timestamp = (Get-Date).ToUniversalTime().ToString('o')
            before    = $null
            after     = @{ source = $Source; serials = @($toSend | ForEach-Object { $_.result.serialNumber }); counts = $counts }
            result    = if ($counts.failed -eq 0) { 'success' } elseif ($counts.imported -gt 0) { 'partial' } else { 'failure' }
        }
    }
}
