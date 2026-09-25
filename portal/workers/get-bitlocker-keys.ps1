# get-bitlocker-keys.ps1 — worker entrypoint for BitLocker key retrieval.
#
# Emits the Get-BitLockerKeys response object as JSON on stdout; stdout is the
# response transport, so key material is not persisted anywhere by this script.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $TenantId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $DeviceId
)

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-BitLockerKeys.ps1')

$result = Get-BitLockerKeys -TenantId $TenantId -DeviceId $DeviceId
$result | ConvertTo-Json -Depth 5 -Compress
