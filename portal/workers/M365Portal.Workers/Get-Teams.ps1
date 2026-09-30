# Get-Teams.ps1 — EPIC-026 Teams list worker (SPEC §2 US-1, §3.1, §6, §7, §9; T-0502).
#
# Live Graph reads only: teams are never mirrored to disk (SPEC §5).
# Teams are enumerated as Teams-enabled Microsoft 365 groups through the Graph
# Teams scopes (app-only per tenant, SPEC §7), following the module's
# Get-TeamsInventory provenance: the groups list carries the §3.1 identity
# columns, and each team's archive state, sensitivity label, owners, and member
# count are read per team. Rows carry Name, Owners, Members, Visibility,
# Archived, Created, Sensitivity.
# Filters (visibility, archived, activity) are applied in the worker so a large
# tenant is never materialized in the BFF. The worker is read-only: only GET
# requests are issued.

function Read-TeamsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-Teams.
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

    $raw = Get-Content -LiteralPath $Path -Raw
    $json = $raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    $result = @{
        TenantId   = [string]$json.tenantId
        Visibility = if ($json.visibility) { [string]$json.visibility } else { '' }
        Archived   = if ($null -ne $json.archived) { [string]$json.archived } else { '' }
        From       = if ($json.from) { [string]$json.from } else { '' }
        To         = if ($json.to) { [string]$json.to } else { '' }
        Top        = if ($json.top) { [int]$json.top } else { 100 }
        Cursor     = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-TeamsCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-TeamsCursor {
    param([string]$Cursor)
    if ([string]::IsNullOrWhiteSpace($Cursor)) { return 0 }
    try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Cursor))
        if ($decoded -match '^offset:(\d+)$') {
            return [int]$Matches[1]
        }
        return 0
    }
    catch {
        return 0
    }
}

function ConvertTo-TeamRow {
    param(
        [object]$Entry,
        [object]$Detail,
        [object]$Owners,
        [object]$Members
    )

    $id = if ($Entry.id) { [string]$Entry.id } else { '' }
    $name = if ($Entry.displayName) { [string]$Entry.displayName } else { '' }

    $visibility = ''
    if ($Entry.visibility -is [string] -and -not [string]::IsNullOrWhiteSpace($Entry.visibility)) {
        $visibility = [string]$Entry.visibility
    }

    $created = ''
    if ($Entry.createdDateTime) { $created = [string]$Entry.createdDateTime }

    $isArchived = $false
    if ($null -ne $Detail -and $null -ne $Detail.isArchived) {
        $isArchived = [bool]$Detail.isArchived
    }

    $sensitivity = ''
    if ($null -ne $Detail -and $Detail.sensitivityLabel -is [string] -and -not [string]::IsNullOrWhiteSpace($Detail.sensitivityLabel)) {
        $sensitivity = [string]$Detail.sensitivityLabel
    }

    $ownerCount = 0
    if ($null -ne $Owners) {
        if ($null -ne $Owners.'@odata.count') {
            $ownerCount = [int]$Owners.'@odata.count'
        }
        elseif ($Owners.value -is [System.Collections.IEnumerable] -and $Owners.value -isnot [string]) {
            $ownerCount = @($Owners.value).Count
        }
    }

    $memberCount = 0
    if ($null -ne $Members) {
        if ($null -ne $Members.'@odata.count') {
            $memberCount = [int]$Members.'@odata.count'
        }
        elseif ($Members.value -is [System.Collections.IEnumerable] -and $Members.value -isnot [string]) {
            $memberCount = @($Members.value).Count
        }
    }

    return [pscustomobject]@{
        id               = $id
        name             = $name
        ownerCount       = $ownerCount
        memberCount      = $memberCount
        visibility       = $visibility
        isArchived       = $isArchived
        createdDateTime  = $created
        sensitivityLabel = $sensitivity
    }
}

function Test-TeamFilter {
    param(
        [object]$Row,
        [string]$Visibility = '',
        [string]$Archived = '',
        [string]$From = '',
        [string]$To = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Visibility)) {
        if ($Row.visibility.Trim().ToLowerInvariant() -ne $Visibility.Trim().ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Archived)) {
        $a = $Archived.Trim().ToLowerInvariant()
        if ($a -in @('true', '1')) {
            if (-not $Row.isArchived) { return $false }
        }
        elseif ($a -in @('false', '0')) {
            if ($Row.isArchived) { return $false }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($From) -or -not [string]::IsNullOrWhiteSpace($To)) {
        $rowTime = [datetime]::MinValue
        try { $rowTime = [datetime]$Row.createdDateTime } catch { return $false }
        if (-not [string]::IsNullOrWhiteSpace($From)) {
            try {
                if ($rowTime -lt [datetime]$From) { return $false }
            }
            catch { return $false }
        }
        if (-not [string]::IsNullOrWhiteSpace($To)) {
            try {
                if ($rowTime -gt [datetime]$To) { return $false }
            }
            catch { return $false }
        }
    }

    return $true
}

function Get-Teams {
    <#
    .SYNOPSIS
        Lists tenant teams live from Microsoft Graph with §3.1 columns and filters.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Visibility = '',

        [Parameter()]
        [string]$Archived = '',

        [Parameter()]
        [string]$From = '',

        [Parameter()]
        [string]$To = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allGroups = [System.Collections.Generic.List[object]]::new()
    $uri = "/v1.0/groups?`$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&`$select=id,displayName,description,visibility,createdDateTime,mail&`$top=999"

    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry) {
                    $allGroups.Add($entry)
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $allGroups) {
        $teamId = [string]$entry.id

        $detail = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/teams/$teamId"
        $owners = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$teamId/owners?`$select=displayName,userPrincipalName"
        $members = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$teamId/members?`$select=id&`$top=1" -Headers @{ 'ConsistencyLevel' = 'eventual' }

        $row = ConvertTo-TeamRow -Entry $entry -Detail $detail -Owners $owners -Members $members
        if (Test-TeamFilter -Row $row -Visibility $Visibility -Archived $Archived -From $From -To $To) {
            $rows.Add($row)
        }
    }

    $offset = ConvertFrom-TeamsCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-TeamsCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
