<#
.SYNOPSIS
    Worker entrypoint for the onboarding prerequisites preflight (T-0915).
.DESCRIPTION
    Reads a job envelope from -JobFile and runs Test-OnboardingPrerequisite, which
    reports the PowerShell modules tenant onboarding needs and the exact install
    commands for any that are missing. Read-only: it probes the worker host and emits
    the result as JSON on stdout.
.PARAMETER JobFile
    Path to the job envelope JSON written by the BFF. The preflight is host-wide, so
    the envelope carries no tenant-specific inputs.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-TenantOnboarding.ps1')

# Read the envelope so a malformed job fails the same way the other entrypoints do.
$null = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json

Test-OnboardingPrerequisite | ConvertTo-Json -Depth 5 -Compress
