# Get-OneDriveUsage.ps1 — EPIC-025 OneDrive usage and sharing overview (SPEC §2 US-6, §3.5, §6, §7; T-0489).
#
# Read-only worker handler: per-user OneDrive storage usage and sharing-link
# state, read live from Graph. Never writes or modifies the tenant. Sharing-link
# descriptors are returned so the portal can hand bulk removal to EPIC-027;
# no removal is performed here.

function Read-OneDriveUsageJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-OneDriveUsage.
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

    return @{
        TenantId = [string]$json.tenantId
    }
}

function Calculate-OneDriveUsage {
    <#
    .SYNOPSIS
        Calculates the OneDrive usage report from per-user drive descriptors. Pure function, testable in isolation.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [object[]]$Users = @(),

        [Parameter()]
        [datetime]$ReferenceDate = (Get-Date)
    )

    $totalUsed = 0L
    $totalQuota = 0L
    $usersWithOneDrive = 0
    $usersOverQuotaWarning = 0
    $totalLinks = 0
    $anonymousLinks = 0
    $organizationLinks = 0
    $userLinks = 0

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($u in $Users) {
        $id = if ($u.id) { [string]$u.id } else { '' }
        $displayName = if ($u.displayName) { [string]$u.displayName } else { '' }
        $upn = if ($u.userPrincipalName) { [string]$u.userPrincipalName } else { '' }

        $hasOneDrive = $false
        $used = 0L
        $quota = 0L
        $usedPercent = $null
        $lastActivity = $null
        if ($u.lastActivityDate) {
            try { $lastActivity = ([datetime]$u.lastActivityDate).ToString('o') } catch { $lastActivity = $null }
        }

        if ($u.driveId) {
            $hasOneDrive = $true
            $usersWithOneDrive++
            if ($null -ne $u.storageUsedBytes) { $used = [long]$u.storageUsedBytes }
            if ($null -ne $u.storageQuotaBytes) { $quota = [long]$u.storageQuotaBytes }
            $totalUsed += $used
            $totalQuota += $quota
            if ($quota -gt 0) {
                $usedPercent = [math]::Round(100 * $used / $quota, 1)
                if ($usedPercent -ge 90) { $usersOverQuotaWarning++ }
            }
        }

        $linkTotal = 0
        $linkAnonymous = 0
        $linkOrganization = 0
        $linkUser = 0
        $linkDetails = [System.Collections.Generic.List[object]]::new()
        if ($u.sharingLinks) {
            foreach ($link in $u.sharingLinks) {
                $linkTotal++
                $linkType = if ($link.linkType) { [string]$link.linkType } else { '' }
                switch ($linkType) {
                    'anonymous' { $linkAnonymous++; $anonymousLinks++ }
                    'organization' { $linkOrganization++; $organizationLinks++ }
                    'user' { $linkUser++; $userLinks++ }
                }
                $linkDetails.Add([pscustomobject]@{
                    linkId       = if ($link.linkId) { [string]$link.linkId } else { '' }
                    linkType     = $linkType
                    resourceName = if ($link.resourceName) { [string]$link.resourceName } else { '' }
                    driveId      = if ($link.driveId) { [string]$link.driveId } else { '' }
                    itemId       = if ($link.itemId) { [string]$link.itemId } else { '' }
                }) | Out-Null
            }
        }
        $totalLinks += $linkTotal

        $rows.Add([pscustomobject]@{
            userId             = $id
            displayName        = $displayName
            userPrincipalName  = $upn
            hasOneDrive        = $hasOneDrive
            storageUsedBytes   = if ($hasOneDrive) { $used } else { $null }
            storageQuotaBytes  = if ($hasOneDrive) { $quota } else { $null }
            storageUsedPercent = $usedPercent
            lastActivityDate   = $lastActivity
            sharing            = [pscustomobject]@{
                total        = $linkTotal
                anonymous    = $linkAnonymous
                organization = $linkOrganization
                user         = $linkUser
            }
            sharingLinks     = @($linkDetails)
        })
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        generatedAt = $ReferenceDate.ToString('o')
        summary     = [pscustomobject]@{
            totalUsers             = @($Users).Count
            usersWithOneDrive      = $usersWithOneDrive
            totalStorageUsedBytes  = $totalUsed
            totalStorageQuotaBytes = $totalQuota
            usersOverQuotaWarning  = $usersOverQuotaWarning
            totalSharingLinks      = $totalLinks
            anonymousLinks         = $anonymousLinks
            organizationLinks      = $organizationLinks
            userLinks              = $userLinks
        }
        users       = @($rows)
    }
}

function Get-OneDriveUsage {
    <#
    .SYNOPSIS
        Reads per-user OneDrive usage and sharing state from Graph. Read-only operation.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [object[]]$Users = $null
    )

    if ($null -eq $Users) {
        $headers = @{
            'ConsistencyLevel' = 'eventual'
        }
        $items = [System.Collections.Generic.List[object]]::new()
        $uri = "https://graph.microsoft.com/v1.0/users?`$select=id,displayName,userPrincipalName&`$top=999"
        do {
            $raw = Invoke-MgGraphRequest -Method GET -Uri $uri -Headers $headers -OutputType PSObject -ErrorAction Stop
            foreach ($value in @($raw.value)) {
                if ($null -ne $value) { $items.Add($value) }
            }
            $uri = if ($raw.'@odata.nextLink') { [string]$raw.'@odata.nextLink' } else { $null }
        } while ($uri)

        $descriptors = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $items) {
            $driveId = $null
            $usedBytes = $null
            $quotaBytes = $null
            $lastActivity = $null
            $sharingLinks = @()

            try {
                $driveUri = "https://graph.microsoft.com/v1.0/users/$($item.id)/drive"
                $drive = Invoke-MgGraphRequest -Method GET -Uri $driveUri -OutputType PSObject -ErrorAction Stop
                $driveId = [string]$drive.id
                if ($drive.quota) {
                    if ($null -ne $drive.quota.used) { $usedBytes = [long]$drive.quota.used }
                    if ($null -ne $drive.quota.total) { $quotaBytes = [long]$drive.quota.total }
                }
                if ($drive.lastModifiedDateTime) { $lastActivity = [string]$drive.lastModifiedDateTime }
            }
            catch {
                # Users without a provisioned OneDrive 404 on /drive; report them as hasOneDrive=false.
                $driveId = $null
            }

            if ($driveId) {
                try {
                    $permUri = "https://graph.microsoft.com/v1.0/drives/$driveId/root/permissions"
                    $perms = Invoke-MgGraphRequest -Method GET -Uri $permUri -OutputType PSObject -ErrorAction Stop
                    $links = [System.Collections.Generic.List[object]]::new()
                    if ($perms.value) {
                        foreach ($perm in $perms.value) {
                            if (-not $perm.link) { continue }
                            $linkType = if ($perm.link.scope) { [string]$perm.link.scope } else { '' }
                            $links.Add([pscustomobject]@{
                                linkId       = [string]$perm.id
                                linkType     = $linkType
                                resourceName = 'root'
                                driveId      = $driveId
                                itemId       = 'root'
                            }) | Out-Null
                        }
                    }
                    $sharingLinks = @($links)
                }
                catch {
                    # Sharing-link read failed; usage is still reported without link data.
                }
            }

            $descriptors.Add([pscustomobject]@{
                id                = $item.id
                displayName       = $item.displayName
                userPrincipalName = $item.userPrincipalName
                driveId           = $driveId
                storageUsedBytes  = $usedBytes
                storageQuotaBytes = $quotaBytes
                lastActivityDate  = $lastActivity
                sharingLinks      = $sharingLinks
            })
        }
        $Users = @($descriptors)
    }

    return Calculate-OneDriveUsage -TenantId $TenantId -Users $Users
}
