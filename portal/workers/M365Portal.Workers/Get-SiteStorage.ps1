# Get-SiteStorage.ps1 — EPIC-025 SharePoint site storage composition (SPEC §3.3, §6, §7; T-0487).
#
# Read-only worker handler: enumerates a site's drive items, item versions, and
# recycle bin items live from Graph (Sites.ReadWrite.All, app-only per §7) and
# returns stored bytes split into documents/versions/recycle bin plus the
# reclaimable total. The worker is read-only: only GET requests are issued.

function Get-SiteStorage {
    <#
    .SYNOPSIS
        Returns the storage composition of a SharePoint site.
    .DESCRIPTION
        Queries Graph for the site's drive items (documents), item versions,
        and recycle bin items, then sums the bytes in each bucket. Reclaimable
        is versions + recycle bin — the space a version cleanup or recycle-bin
        empty would free.
    .PARAMETER TenantId
    .PARAMETER SiteId
    .OUTPUTS
        [pscustomobject] with tenantId, siteId, documentsBytes, versionsBytes,
        recycleBinBytes, reclaimableBytes, totalBytes, generatedAt.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId
    )

    $documentsBytes = [int64]0
    $uri = "/v1.0/sites/$SiteId/drive/items?`$select=id,size"
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry.size) {
                    $documentsBytes += [int64]$entry.size
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    $versionsBytes = [int64]0
    $itemsUri = "/v1.0/sites/$SiteId/drive/items?`$select=id"
    do {
        $itemsResponse = Invoke-MgGraphRequest -Method GET -Uri $itemsUri
        if ($null -ne $itemsResponse -and $null -ne $itemsResponse.value) {
            foreach ($item in @($itemsResponse.value)) {
                $itemId = [string]$item.id
                $versionsUri = "/v1.0/sites/$SiteId/drive/items/$itemId/versions?`$select=id,size"
                do {
                    $versionsResponse = Invoke-MgGraphRequest -Method GET -Uri $versionsUri
                    if ($null -ne $versionsResponse -and $null -ne $versionsResponse.value) {
                        foreach ($version in @($versionsResponse.value)) {
                            if ($null -ne $version.size) {
                                $versionsBytes += [int64]$version.size
                            }
                        }
                    }
                    $versionsUri = if ($versionsResponse.'@odata.nextLink') { $versionsResponse.'@odata.nextLink' } else { $null }
                } while ($versionsUri)
            }
        }
        $itemsUri = if ($itemsResponse.'@odata.nextLink') { $itemsResponse.'@odata.nextLink' } else { $null }
    } while ($itemsUri)

    $recycleBinBytes = [int64]0
    $recycleUri = "/v1.0/sites/$SiteId/drive/recycleBin/items?`$select=id,size"
    do {
        $recycleResponse = Invoke-MgGraphRequest -Method GET -Uri $recycleUri
        if ($null -ne $recycleResponse -and $null -ne $recycleResponse.value) {
            foreach ($entry in @($recycleResponse.value)) {
                if ($null -ne $entry.size) {
                    $recycleBinBytes += [int64]$entry.size
                }
            }
        }
        $recycleUri = if ($recycleResponse.'@odata.nextLink') { $recycleResponse.'@odata.nextLink' } else { $null }
    } while ($recycleUri)

    $reclaimableBytes = $versionsBytes + $recycleBinBytes

    return [pscustomobject]@{
        tenantId         = $TenantId
        siteId           = $SiteId
        documentsBytes   = $documentsBytes
        versionsBytes    = $versionsBytes
        recycleBinBytes  = $recycleBinBytes
        reclaimableBytes = $reclaimableBytes
        totalBytes       = $documentsBytes + $reclaimableBytes
        generatedAt      = [DateTime]::UtcNow.ToString('o')
    }
}
