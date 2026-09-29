# DnsSelectors.ps1 — DKIM selector discovery for the DNS analysis worker (T-0664).
#
# Resolves which DKIM selectors are published for a domain by trying the known
# selectors (selector1/selector2 plus common provider defaults) and honouring
# a per-tenant selector override. SPEC §11.1: try the known selectors and allow
# a per-tenant selector override, resolved by the DNS-analysis worker.

function Get-DnsSelectorCandidates {
    <#
    .SYNOPSIS
        Returns the ordered list of DKIM selector names to try for a domain.
    .DESCRIPTION
        The known selectors are selector1/selector2 (Microsoft 365 defaults)
        plus common provider defaults. A per-tenant override, when present,
        is tried first.
    .PARAMETER Override
        Optional per-tenant selector override. When provided, it is tried first.
    .EXAMPLE
        Get-DnsSelectorCandidates -Override 'custom'
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [string]$Override = ''
    )

    $candidates = @()
    if ($Override) {
        $candidates += $Override
    }
    $candidates += @('selector1', 'selector2', 'google', 'amazon', 'pp', 'mc', 'b', 'cisco')
    return @($candidates | Select-Object -Unique)
}

function Resolve-DnsSelectors {
    <#
    .SYNOPSIS
        Resolves the DKIM selectors published for a domain.
    .DESCRIPTION
        Tries each candidate selector in order and returns the ones that
        resolve to a CNAME. A per-tenant override is tried first when provided.
        Uses the module's Resolve-DnsRecord for cross-platform DNS resolution.
    .PARAMETER Domain
        The domain to resolve DKIM selectors for.
    .PARAMETER Override
        Optional per-tenant selector override.
    .EXAMPLE
        Resolve-DnsSelectors -Domain 'contoso.com'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter()]
        [string]$Override = ''
    )

    $dnsHelperPath = Join-Path -Path $PSScriptRoot '../../../src/M365-Assess/Common/Resolve-DnsRecord.ps1'
    if (Test-Path -Path $dnsHelperPath) { . $dnsHelperPath }

    $candidates = Get-DnsSelectorCandidates -Override $Override
    $found = @()
    foreach ($selector in $candidates) {
        $name = "$selector._domainkey.$Domain"
        $record = Resolve-DnsRecord -Name $name -Type CNAME -ErrorAction SilentlyContinue
        if ($record -and $record.NameHost) {
            $found += [pscustomobject]@{
                Selector = $selector
                NameHost = $record.NameHost
            }
        }
    }

    return [pscustomobject]@{
        Domain    = $Domain
        Selectors = @($found)
    }
}
