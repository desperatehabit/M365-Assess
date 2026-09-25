# Get-BitLockerKeys.ps1 — EPIC-018 BitLocker recovery-key retrieval (SPEC §4.2, §6).
#
# Returns the device's recovery key(s) with metadata in the response object
# only. Key material is never written to the database, logs, or artifacts;
# auditing of each reveal is the caller's responsibility (KeyAccessAudit).

function Get-BitLockerKeys {
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

    $filter = "deviceId eq '$DeviceId'"
    $listUri = "https://graph.microsoft.com/v1.0/informationProtection/bitlocker/recoveryKeys?`$filter=$filter"
    $listResponse = Invoke-MgGraphRequest -Method GET -Uri $listUri

    $keys = @()
    foreach ($entry in @($listResponse.value)) {
        $detailUri = "https://graph.microsoft.com/v1.0/informationProtection/bitlocker/recoveryKeys/$($entry.id)?`$select=key,createdDateTime"
        $detail = Invoke-MgGraphRequest -Method GET -Uri $detailUri
        $keys += [pscustomobject]@{
            keyId     = $entry.id
            key       = $detail.key
            keyType   = 'bitlocker'
            createdAt = $detail.createdDateTime
        }
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        deviceId    = $DeviceId
        keys        = $keys
        retrievedAt = (Get-Date -Format 'o')
    }
}
