# Get-TenantUsers.ps1 — EPIC-011 user directory read (SPEC §3.1, §3.2, §4.1, §6, §11.2).
#
# Live Graph reads only: user objects are never mirrored, so every call pages
# /users directly and shapes rows to the §3.1 columns (display name, UPN, type,
# licenses, MFA state, last sign-in, status, department). Filtering and cursor
# paging happen over that single read so the inactive, guest, and sign-in
# report views share one path. The caller (child entrypoint) runs with the
# Graph session the supervisor connected after materializing the tenant
# credential in-process; this file never touches secrets.

function Get-TenantUsers {
    <#
    .SYNOPSIS
        Lists tenant users from Graph live with search, filters, and cursor paging.
    .DESCRIPTION
        Pages /users with a fixed $select (falling back without signInActivity
        where AuditLog.Read.All or Entra ID P1 is missing), resolves MFA state
        from the registration-details report, maps each user to the EPIC-011
        §3.1 columns, then applies the requested filters and returns one cursor
        page. Only GET requests are issued; nothing is written to the tenant.
    .PARAMETER TenantId
        Tenant the users belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against display name and UPN.
    .PARAMETER Status
        Filter by account state: enabled or disabled.
    .PARAMETER UserType
        Filter by directory type: member or guest.
    .PARAMETER License
        licensed keeps users with at least one assigned license, unlicensed the rest.
    .PARAMETER MfaState
        Filter by MFA registration: registered, notRegistered, or unknown.
    .PARAMETER Department
        Case-insensitive exact match against department.
    .PARAMETER InactiveDays
        Keeps users whose last sign-in is older than this many days, or never signed in. 0 disables.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .PARAMETER OrderByLastSignIn
        Sorts the filtered set by last sign-in descending (never-signed-in last)
        before paging. Used by the sign-in report view.
    .EXAMPLE
        Get-TenantUsers -TenantId 'tenant-a' -UserType 'guest' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateSet('', 'enabled', 'disabled')]
        [string]$Status = '',

        [Parameter()]
        [ValidateSet('', 'member', 'guest')]
        [string]$UserType = '',

        [Parameter()]
        [ValidateSet('', 'licensed', 'unlicensed')]
        [string]$License = '',

        [Parameter()]
        [ValidateSet('', 'registered', 'notRegistered', 'unknown')]
        [string]$MfaState = '',

        [Parameter()]
        [string]$Department = '',

        [Parameter()]
        [ValidateRange(0, 3650)]
        [int]$InactiveDays = 0,

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = '',

        [Parameter()]
        [switch]$OrderByLastSignIn
    )

    $selectFields = 'id,displayName,userPrincipalName,userType,assignedLicenses,accountEnabled,department,signInActivity'
    $uri = "/v1.0/users?`$select=$selectFields&`$top=999"

    $allUsers = [System.Collections.Generic.List[object]]::new()
    $withoutSignInActivity = $false
    do {
        try {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        }
        catch {
            if (-not $withoutSignInActivity -and $_.ToString() -match 'signInActivity|AuditLog|Authorization_RequestDenied') {
                $withoutSignInActivity = $true
                $selectFields = 'id,displayName,userPrincipalName,userType,accountEnabled,assignedLicenses,department'
                $uri = "/v1.0/users?`$select=$selectFields&`$top=999"
                $allUsers.Clear()
                continue
            }
            throw
        }
        foreach ($entry in @($response.value)) {
            if ($null -ne $entry) {
                $allUsers.Add($entry)
            }
        }
        $uri = $response.'@odata.nextLink'
    } while ($uri)

    $mfaByUser = Get-TenantUserMfaMap

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($user in $allUsers) {
        $row = ConvertTo-TenantUserRow -User $user -MfaByUser $mfaByUser
        if (Test-TenantUserFilter -Row $row -Search $Search -Status $Status -UserType $UserType -License $License -MfaState $MfaState -Department $Department -InactiveDays $InactiveDays) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows)
    if ($OrderByLastSignIn) {
        $signedIn = @($ordered | Where-Object { $_.lastSignInDateTime })
        $neverSignedIn = @($ordered | Where-Object { -not $_.lastSignInDateTime })
        $signedInDescending = @($signedIn | Sort-Object -Property lastSignInDateTime -Descending)
        $ordered = @($signedInDescending) + @($neverSignedIn)
    }

    $offset = ConvertFrom-TenantUsersCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-TenantUsersCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Get-InactiveTenantUsers {
    <#
    .SYNOPSIS
        Inactive-users report view over the shared user read path.
    .DESCRIPTION
        Delegates to Get-TenantUsers with an inactivity threshold so the report
        cannot drift from the directory list. Users that never signed in count
        as inactive.
    .PARAMETER TenantId
        Tenant the users belong to.
    .PARAMETER InactiveDays
        Sign-in age threshold in days. Defaults to 90.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result.
    .EXAMPLE
        Get-InactiveTenantUsers -TenantId 'tenant-a'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateRange(1, 3650)]
        [int]$InactiveDays = 90,

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    return Get-TenantUsers -TenantId $TenantId -InactiveDays $InactiveDays -Top $Top -Cursor $Cursor
}

function Get-GuestTenantUsers {
    <#
    .SYNOPSIS
        Guest-users report view over the shared user read path.
    .DESCRIPTION
        Delegates to Get-TenantUsers pinned to the guest type so the report
        cannot drift from the directory list.
    .PARAMETER TenantId
        Tenant the users belong to.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result.
    .EXAMPLE
        Get-GuestTenantUsers -TenantId 'tenant-a'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    return Get-TenantUsers -TenantId $TenantId -UserType 'guest' -Top $Top -Cursor $Cursor
}

function Get-TenantUserSignInReport {
    <#
    .SYNOPSIS
        Sign-in report view over the shared user read path.
    .DESCRIPTION
        Delegates to Get-TenantUsers with most-recent-first ordering so the
        report cannot drift from the directory list.
    .PARAMETER TenantId
        Tenant the users belong to.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result.
    .EXAMPLE
        Get-TenantUserSignInReport -TenantId 'tenant-a'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    return Get-TenantUsers -TenantId $TenantId -OrderByLastSignIn -Top $Top -Cursor $Cursor
}

function Read-TenantUsersJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-TenantUsers parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then merges the
        optional payload filters with explicit overrides. The envelope carries
        references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-TenantUsersJob -Path './run/users-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Tenant users job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Tenant users job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Tenant users job is missing required field: tenantId'
    }

    $filters = $job['payload']
    if ($filters -is [System.Collections.IDictionary]) {
        $nested = $filters['filters']
        if ($nested -is [System.Collections.IDictionary]) {
            $filters = $nested
        }
    }
    else {
        $filters = @{}
    }

    return @{
        TenantId     = $tenantId
        Search       = [string]$filters['search']
        Status       = [string]$filters['status']
        UserType     = [string]$filters['type']
        License      = [string]$filters['license']
        MfaState     = [string]$filters['mfaState']
        Department   = [string]$filters['department']
        InactiveDays = Get-TenantUsersJobInt -Value $filters['inactiveDays']
        Top          = Get-TenantUsersJobInt -Value $filters['top'] -Default 100
        Cursor       = [string]$filters['cursor']
    }
}

function Get-TenantUsersJobInt {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [object]$Value,

        [Parameter()]
        [int]$Default = 0
    )

    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        return $Default
    }
    $parsed = 0
    if ([int]::TryParse([string]$Value, [ref]$parsed)) {
        return $parsed
    }
    return $Default
}

function Get-TenantUserMfaMap {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()

    $map = @{}
    try {
        $uri = '/v1.0/reports/authenticationMethods/userRegistrationDetails?$select=id,userPrincipalName,isMfaRegistered&$top=999'
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            foreach ($entry in @($response.value)) {
                if ($null -eq $entry) {
                    continue
                }
                $registered = $entry.isMfaRegistered -eq $true
                $state = 'notRegistered'
                if ($registered) {
                    $state = 'registered'
                }
                foreach ($key in @($entry.userPrincipalName, $entry.id)) {
                    $text = [string]$key
                    if ($text.Trim().Length -gt 0) {
                        $map[$text.Trim().ToLowerInvariant()] = $state
                    }
                }
            }
            $uri = $response.'@odata.nextLink'
        } while ($uri)
    }
    catch {
        return @{}
    }
    return $map
}

function ConvertTo-TenantUserRow {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$User,

        [Parameter()]
        [hashtable]$MfaByUser = @{}
    )

    $rawType = [string]$User.userType
    $userType = 'member'
    if ($rawType.Trim().ToLowerInvariant() -eq 'guest') {
        $userType = 'guest'
    }

    $skuIds = @()
    foreach ($license in @($User.assignedLicenses)) {
        if ($null -eq $license) {
            continue
        }
        $sku = [string]$license.skuId
        if ($sku.Trim().Length -gt 0) {
            $skuIds += $sku
        }
    }

    $status = 'disabled'
    if ($User.accountEnabled -eq $true) {
        $status = 'enabled'
    }

    $lastSignIn = $null
    if ($null -ne $User.signInActivity) {
        $rawSignIn = [string]$User.signInActivity.lastSignInDateTime
        if ($rawSignIn.Trim().Length -gt 0) {
            $lastSignIn = $rawSignIn
        }
    }

    $mfaState = 'unknown'
    foreach ($key in @($User.userPrincipalName, $User.id)) {
        $text = [string]$key
        if ($text.Trim().Length -gt 0 -and $MfaByUser.ContainsKey($text.Trim().ToLowerInvariant())) {
            $mfaState = $MfaByUser[$text.Trim().ToLowerInvariant()]
            break
        }
    }

    $department = $null
    $rawDepartment = [string]$User.department
    if ($rawDepartment.Trim().Length -gt 0) {
        $department = [string]$User.department
    }

    return [pscustomobject]@{
        id                  = [string]$User.id
        displayName         = [string]$User.displayName
        userPrincipalName   = [string]$User.userPrincipalName
        userType            = $userType
        licenses            = $skuIds
        mfaState            = $mfaState
        lastSignInDateTime  = $lastSignIn
        status              = $status
        department          = $department
    }
}

function Test-TenantUserFilter {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [string]$Status = '',

        [Parameter()]
        [string]$UserType = '',

        [Parameter()]
        [string]$License = '',

        [Parameter()]
        [string]$MfaState = '',

        [Parameter()]
        [string]$Department = '',

        [Parameter()]
        [int]$InactiveDays = 0
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        $haystack = ("{0} {1}" -f $Row.displayName, $Row.userPrincipalName).ToLowerInvariant()
        if (-not $haystack.Contains($needle)) {
            return $false
        }
    }
    if ($Status.Trim().Length -gt 0 -and $Row.status -ne $Status.Trim().ToLowerInvariant()) {
        return $false
    }
    if ($UserType.Trim().Length -gt 0 -and $Row.userType -ne $UserType.Trim().ToLowerInvariant()) {
        return $false
    }
    if ($License.Trim().Length -gt 0) {
        $licensed = @($Row.licenses).Count -gt 0
        if ($License.Trim().ToLowerInvariant() -eq 'licensed' -and -not $licensed) {
            return $false
        }
        if ($License.Trim().ToLowerInvariant() -eq 'unlicensed' -and $licensed) {
            return $false
        }
    }
    if ($MfaState.Trim().Length -gt 0 -and $Row.mfaState -ne $MfaState.Trim()) {
        return $false
    }
    if ($Department.Trim().Length -gt 0) {
        if ([string]$Row.department -eq '' -or ([string]$Row.department).Trim().ToLowerInvariant() -ne $Department.Trim().ToLowerInvariant()) {
            return $false
        }
    }
    if ($InactiveDays -gt 0) {
        $cutoff = (Get-Date).ToUniversalTime().AddDays(-$InactiveDays)
        if ($Row.lastSignInDateTime) {
            $seen = [datetime]$Row.lastSignInDateTime
            if ($seen.ToUniversalTime() -ge $cutoff) {
                return $false
            }
        }
    }
    return $true
}

function ConvertTo-TenantUsersCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-TenantUsersCursor {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [string]$Cursor = ''
    )

    if ([string]::IsNullOrWhiteSpace($Cursor)) {
        return 0
    }
    try {
        $text = $Cursor.Trim().Replace('-', '+').Replace('_', '/')
        $pad = (4 - ($text.Length % 4)) % 4
        $text += ('=' * $pad)
        $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text))
        $offset = 0
        if ([int]::TryParse($decoded, [ref]$offset) -and $offset -ge 0) {
            return $offset
        }
    }
    catch {
        Write-Verbose "Ignoring undecodable users cursor and starting at the first page."
    }
    return 0
}
