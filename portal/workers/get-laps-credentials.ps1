# get-laps-credentials.ps1 — worker entrypoint for LAPS credential retrieval.
#
# Emits the Get-LapsCredentials response object as JSON on stdout; stdout is the
# response transport, so credential material is not persisted anywhere by this script.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $TenantId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $DeviceId
)

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-LapsCredentials.ps1')

$result = Get-LapsCredentials -TenantId $TenantId -DeviceId $DeviceId
$result | ConvertTo-Json -Depth 5 -Compress
