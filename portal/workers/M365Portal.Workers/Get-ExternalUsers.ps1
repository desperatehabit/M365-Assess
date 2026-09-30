# Get-ExternalUsers.ps1 — EPIC-027 SharePoint external-users report
# (EPIC-027 SPEC.md §2 US-3, §3.3, §6; T-0525).
#
# Read-only worker handler: reuses the T-0482 site list (Get-SharePointSites),
# reads each site's permissions live from Graph, and aggregates the external
# grantees into the §3.3 columns — External user, Email, Sites, Last access,
# Invited by — with cursor pagination. -ExternalUserId drills through to the
# sites/items one external user can access. A grantee is external when their
# email domain is not one of the tenant's verified domains (or when Graph
# reports them as a non-directory siteUser). Only GET requests are issued and
# nothing is written to the tenant.

if (-not (Get-Command Get-SharePointSites -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path -Path $PSScriptRoot -ChildPath 'Get-SharePointSites.ps1')
}

function ConvertTo-ExternalUsersCursor {
    <#
    .SYNOPSIS
        Encodes a row offset into the opaque external-users cursor.
    .PARAMETER Offset
        Zero-based row offset into the aggregated user set.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    if ($Offset -le 0) {
        return ''
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-ExternalUsersCursor {
    <#
    .SYNOPSIS
        Decodes the opaque external-users cursor back into a row offset.
    .DESCRIPTION
        An undecodable cursor restarts at the first page instead of failing the
        read; the report is read-only, so a bad cursor must not be fatal.
    .PARAMETER Cursor
        The cursor from a previous result. Empty starts at the first page.
    #>
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
        Write-Verbose 'Ignoring undecodable external-users cursor and starting at the first page.'
    }
    return 0
}

function Get-ExternalUsersTenantDomains {
    <#
    .SYNOPSIS
        Reads the tenant's verified domain names for external-grantee classification.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    $domains = [System.Collections.Generic.List[string]]::new()
    try {
        $uri = '/v1.0/domains?$select=id'
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry -and -not [string]::IsNullOrWhiteSpace([string]$entry.id)) {
                    $domains.Add(([string]$entry.id).Trim().ToLowerInvariant())
                }
            }
            $uri = $response.'@odata.nextLink'
        } while ($uri)
    }
    catch {
        Write-Verbose "Could not read tenant domains: $($_.Exception.Message)"
    }
    return @($domains)
}

function Test-ExternalUserEmail {
    <#
    .SYNOPSIS
        Decides whether a grantee email belongs to an external user.
    .PARAMETER Email
        The grantee email address.
    .PARAMETER InternalDomains
        The tenant's verified domain names, lowercased.
    .PARAMETER IsSiteUser
        True when Graph reported the grantee as a non-directory siteUser, which
        is external by definition regardless of the domain list.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [string]$Email = '',

        [Parameter()]
        [string[]]$InternalDomains = @(),

        [Parameter()]
        [switch]$IsSiteUser
    )

    if ([string]::IsNullOrWhiteSpace($Email)) {
        return $false
    }
    if ($IsSiteUser) {
        return $true
    }
    $at = $Email.IndexOf('@')
    if ($at -lt 1 -or $at -eq $Email.Length - 1) {
        return $false
    }
    $domain = $Email.Substring($at + 1).Trim().ToLowerInvariant()
    foreach ($internal in @($InternalDomains)) {
        if ([string]$internal -eq $domain) {
            return $false
        }
    }
    return $true
}

function Get-ExternalUsersSitePermissions {
    <#
    .SYNOPSIS
        Reads every permission grant on one site, paging the Graph collection.
    .PARAMETER SiteId
        Graph site id.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId
    )

    $permissions = [System.Collections.Generic.List[object]]::new()
    $uri = "/v1.0/sites/$SiteId/permissions?`$top=999"
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        foreach ($entry in @($response.value)) {
            if ($null -ne $entry) {
                $permissions.Add($entry)
            }
        }
        $uri = $response.'@odata.nextLink'
    } while ($uri)
    return @($permissions)
}

function Get-ExternalUserSignInMap {
    <#
    .SYNOPSIS
        Maps guest mail/UPN to their last sign-in for the §3.3 Last access column.
    .DESCRIPTION
        A missing AuditLog permission or Entra ID P1 returns an empty map; the
        report then shows no last access rather than failing the read.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()

    $map = @{}
    try {
        $uri = "/v1.0/users?`$filter=userType eq 'Guest'&`$select=id,mail,userPrincipalName,signInActivity&`$top=999"
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            foreach ($entry in @($response.value)) {
                if ($null -eq $entry) {
                    continue
                }
                $last = ''
                if ($null -ne $entry.signInActivity) {
                    $last = [string]$entry.signInActivity.lastSignInDateTime
                }
                if ($last.Trim().Length -eq 0) {
                    continue
                }
                foreach ($key in @($entry.mail, $entry.userPrincipalName)) {
                    $text = [string]$key
                    if ($text.Trim().Length -gt 0) {
                        $map[$text.Trim().ToLowerInvariant()] = $last
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

function Get-ExternalUserGrantee {
    <#
    .SYNOPSIS
        Extracts the user identity and email from one granted identity entry.
    .PARAMETER Identity
        A grantedToIdentitiesV2 entry.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [object]$Identity
    )

    if ($null -eq $Identity) {
        return $null
    }
    $isSiteUser = $false
    $grantee = $null
    if ($null -ne $Identity.user) {
        $grantee = $Identity.user
    }
    elseif ($null -ne $Identity.siteUser) {
        $grantee = $Identity.siteUser
        $isSiteUser = $true
    }
    if ($null -eq $grantee) {
        return $null
    }
    $email = [string]$grantee.email
    if ($email.Trim().Length -eq 0) {
        $email = [string]$grantee.loginName
    }
    if ($email.Trim().Length -eq 0) {
        return $null
    }
    $display = [string]$grantee.displayName
    if ($display.Trim().Length -eq 0) {
        $display = $email
    }
    return [pscustomobject]@{
        Email      = $email
        Display    = $display
        IsSiteUser = $isSiteUser
    }
}

function Get-ExternalUserInvitedBy {
    <#
    .SYNOPSIS
        Resolves the §3.3 Invited by value from a permission's invitation.
    .PARAMETER Permission
        A Graph permission resource.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [object]$Permission
    )

    if ($null -eq $Permission -or $null -eq $Permission.invitation) {
        return $null
    }
    $invitedBy = $Permission.invitation.invitedBy
    if ($null -eq $invitedBy) {
        return $null
    }
    if ($null -ne $invitedBy.user) {
        if (-not [string]::IsNullOrWhiteSpace([string]$invitedBy.user.displayName)) {
            return [string]$invitedBy.user.displayName
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$invitedBy.user.email)) {
            return [string]$invitedBy.user.email
        }
    }
    if ($null -ne $invitedBy.application -and -not [string]::IsNullOrWhiteSpace([string]$invitedBy.application.displayName)) {
        return [string]$invitedBy.application.displayName
    }
    return $null
}

function Get-ExternalUserAccessIndex {
    <#
    .SYNOPSIS
        Aggregates external grantees and their per-site access across the tenant.
    .DESCRIPTION
        Reuses the T-0482 site list, reads each site's permissions live, and
        returns both the per-user aggregate and the flat access entries so the
        list and the drill-through cannot drift. Filtering and paging stay with
        the callers.
    .PARAMETER TenantId
        Tenant the sites belong to.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId
    )

    $internalDomains = Get-ExternalUsersTenantDomains
    $signInMap = Get-ExternalUserSignInMap

    $sites = [System.Collections.Generic.List[object]]::new()
    $siteCursor = ''
    do {
        $sitePage = Get-SharePointSites -TenantId $TenantId -Top 1000 -Cursor $siteCursor
        foreach ($site in @($sitePage.items)) {
            if ($null -ne $site) {
                $sites.Add($site)
            }
        }
        $siteCursor = [string]$sitePage.nextCursor
    } while (-not [string]::IsNullOrWhiteSpace($siteCursor))

    $users = @{}
    $access = [System.Collections.Generic.List[object]]::new()

    foreach ($site in $sites) {
        $siteId = [string]$site.id
        if ($siteId.Trim().Length -eq 0) {
            continue
        }
        $siteName = [string]$site.name
        $siteUrl = [string]$site.url

        $permissions = Get-ExternalUsersSitePermissions -SiteId $siteId
        foreach ($permission in $permissions) {
            $roles = @($permission.roles)
            $linkType = $null
            if ($null -ne $permission.link -and -not [string]::IsNullOrWhiteSpace([string]$permission.link.type)) {
                $linkType = [string]$permission.link.type
            }
            $invitedBy = Get-ExternalUserInvitedBy -Permission $permission
            $invitedAt = $null
            if ($null -ne $permission.createdDateTime -and -not [string]::IsNullOrWhiteSpace([string]$permission.createdDateTime)) {
                $invitedAt = [string]$permission.createdDateTime
            }
            $itemId = $null
            if ($null -ne $permission.itemId -and -not [string]::IsNullOrWhiteSpace([string]$permission.itemId)) {
                $itemId = [string]$permission.itemId
            }
            $itemName = $null
            if ($null -ne $permission.itemName -and -not [string]::IsNullOrWhiteSpace([string]$permission.itemName)) {
                $itemName = [string]$permission.itemName
            }

            $identities = @()
            if ($null -ne $permission.grantedToIdentitiesV2) {
                $identities = @($permission.grantedToIdentitiesV2)
            }
            elseif ($null -ne $permission.grantedToIdentities) {
                $identities = @($permission.grantedToIdentities)
            }

            foreach ($identity in $identities) {
                $grantee = Get-ExternalUserGrantee -Identity $identity
                if ($null -eq $grantee) {
                    continue
                }
                $isExternal = Test-ExternalUserEmail -Email $grantee.Email -InternalDomains $internalDomains -IsSiteUser:$grantee.IsSiteUser
                if (-not $isExternal) {
                    continue
                }
                $key = $grantee.Email.Trim().ToLowerInvariant()
                $lastAccess = $null
                if ($signInMap.ContainsKey($key)) {
                    $lastAccess = [string]$signInMap[$key]
                }

                $access.Add([pscustomobject]@{
                    externalUserId = $key
                    externalUser   = $grantee.Display
                    email          = $grantee.Email
                    siteId         = $siteId
                    siteName       = $siteName
                    siteUrl        = $siteUrl
                    itemId         = $itemId
                    itemName       = $itemName
                    roles          = $roles
                    linkType       = $linkType
                    invitedBy      = $invitedBy
                    invitedAt      = $invitedAt
                    lastAccess     = $lastAccess
                })

                if (-not $users.ContainsKey($key)) {
                    $users[$key] = [pscustomobject]@{
                        externalUserId = $key
                        externalUser   = $grantee.Display
                        email          = $grantee.Email
                        sites          = [System.Collections.Generic.List[string]]::new()
                        siteIds        = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                        lastAccess     = $null
                        invitedBy      = $null
                    }
                }
                $record = $users[$key]
                if ($record.siteIds.Add($siteId)) {
                    $record.sites.Add($siteName)
                }
                if (-not [string]::IsNullOrWhiteSpace([string]$lastAccess)) {
                    if ($null -eq $record.lastAccess -or [datetime]$lastAccess -gt [datetime]$record.lastAccess) {
                        $record.lastAccess = $lastAccess
                    }
                }
                if ($null -eq $record.invitedBy -and -not [string]::IsNullOrWhiteSpace([string]$invitedBy)) {
                    $record.invitedBy = $invitedBy
                }
            }
        }
    }

    return [pscustomobject]@{
        Users  = @($users.Values)
        Access = @($access)
    }
}

function Get-ExternalUsers {
    <#
    .SYNOPSIS
        Lists tenant SharePoint external users with the §3.3 columns and paging.
    .DESCRIPTION
        Aggregates external grantees across the T-0482 site list, applies the
        optional search filter, and returns one cursor page of user rows.
    .PARAMETER TenantId
        Tenant the external users belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against display name and email.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-ExternalUsers -TenantId 'tenant-a' -Top 50
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
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $index = Get-ExternalUserAccessIndex -TenantId $TenantId

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($record in $index.Users) {
        $sites = @($record.sites | Sort-Object)
        $accessCount = @($index.Access | Where-Object { $_.externalUserId -eq $record.externalUserId }).Count
        $row = [pscustomobject]@{
            externalUserId = $record.externalUserId
            externalUser   = $record.externalUser
            email          = $record.email
            sites          = $sites
            siteCount      = $sites.Count
            accessCount    = $accessCount
            lastAccess     = $record.lastAccess
            invitedBy      = $record.invitedBy
        }
        if ($Search.Trim().Length -gt 0) {
            $needle = $Search.Trim().ToLowerInvariant()
            $haystack = ("{0} {1}" -f $row.externalUser, $row.email).ToLowerInvariant()
            if (-not $haystack.Contains($needle)) {
                continue
            }
        }
        $rows.Add($row)
    }

    $ordered = @($rows | Sort-Object -Property externalUser, email)
    $offset = ConvertFrom-ExternalUsersCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-ExternalUsersCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Get-ExternalUserAccess {
    <#
    .SYNOPSIS
        Drill-through: the sites/items one external user can access.
    .DESCRIPTION
        Returns one cursor page of access entries for the selected external user
        so the page can list exactly which sites and items they can reach.
    .PARAMETER TenantId
        Tenant the external user belongs to.
    .PARAMETER ExternalUserId
        The external user key (email) from the list row.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-ExternalUserAccess -TenantId 'tenant-a' -ExternalUserId 'jane@partner.invalid'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ExternalUserId,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $key = $ExternalUserId.Trim().ToLowerInvariant()
    $index = Get-ExternalUserAccessIndex -TenantId $TenantId
    $entries = @($index.Access | Where-Object { $_.externalUserId -eq $key } | Sort-Object -Property siteName, itemName)

    $offset = ConvertFrom-ExternalUsersCursor -Cursor $Cursor
    $page = @($entries | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $entries.Count) {
        $nextCursor = ConvertTo-ExternalUsersCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId       = $TenantId
        externalUserId = $key
        items          = $page
        nextCursor     = $nextCursor
        totalCount     = $entries.Count
        retrievedAt    = (Get-Date -Format 'o')
    }
}

function Read-ExternalUsersJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-ExternalUsers parameters.
    .DESCRIPTION
        Validates the tenant id and carries the optional search, drill-through,
        and pagination fields. The envelope carries references only; secrets are
        never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ExternalUsersJob -Path './run/external-users-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "External users job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'External users job is missing required field: tenantId'
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
        TenantId       = $tenantId
        Search         = [string]$filters['search']
        ExternalUserId = [string]$filters['externalUserId']
        Top            = Get-ExternalUsersJobInt -Value $filters['top'] -Default 100
        Cursor         = [string]$filters['cursor']
    }
}

function Get-ExternalUsersJobInt {
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
