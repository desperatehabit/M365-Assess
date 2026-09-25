# Get-LapsCredentials.ps1 — EPIC-018 LAPS credential retrieval (SPEC §2 US-5, §3.4, §6, §11.4).
#
# Probes both backends — Windows LAPS first, then legacy LAPS — and returns
# whichever holds a credential for the device, with the backend identified.
# A device with neither credential throws a structured not-found error.
# The credential travels in the response object only; it is never written to
# the database, logs, or artifacts. Auditing of each reveal is the caller's
# responsibility (KeyAccessAudit).

function Get-LapsCredentials {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string] $TenantId,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string] $DeviceId
    )

    $windowsUri = "https://graph.microsoft.com/v1.0/directory/deviceLocalCredentials/$DeviceId?`$select=id,credentials"
    $windowsResponse = $null
    try {
        $windowsResponse = Invoke-MgGraphRequest -Method GET -Uri $windowsUri
    } catch {
        $windowsResponse = $null
    }

    $windowsCreds = @($windowsResponse.credentials) | Where-Object { $_ -and ($_.passwordBase64 -or $_.password) }
    if (@($windowsCreds).Count -gt 0) {
        $selected = @($windowsCreds)[0]
        $password = if ($selected.passwordBase64) { $selected.passwordBase64 } else { $selected.password }
        return [pscustomobject]@{
            tenantId    = $TenantId
            deviceId    = $DeviceId
            backend     = 'windowsLaps'
            accountName = $selected.accountName
            password    = $password
            backedUpAt  = $selected.backupDateTime
            retrievedAt = (Get-Date -Format 'o')
        }
    }

    $legacyUri = "https://graph.microsoft.com/v1.0/devices/$DeviceId/getLocalAdminPassword"
    $legacyResponse = $null
    try {
        $legacyResponse = Invoke-MgGraphRequest -Method GET -Uri $legacyUri
    } catch {
        $legacyResponse = $null
    }

    $legacyPassword = $legacyResponse.passwordBase64
    if (-not $legacyPassword) {
        $legacyPassword = $legacyResponse.password
    }
    if ($legacyPassword) {
        return [pscustomobject]@{
            tenantId    = $TenantId
            deviceId    = $DeviceId
            backend     = 'legacyLaps'
            accountName = $legacyResponse.accountName
            password    = $legacyPassword
            backedUpAt  = $legacyResponse.backupDateTime
            retrievedAt = (Get-Date -Format 'o')
        }
    }

    throw "LAPS credential not found for device '$DeviceId' (code: laps.not_found)."
}
