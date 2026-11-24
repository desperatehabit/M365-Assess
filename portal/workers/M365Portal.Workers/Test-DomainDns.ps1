# Test-DomainDns.ps1 — EPIC-034 DNS analysis worker (SPEC §3.2, §4.2, §6; T-0664).
#
# Resolves the six families the Domain Analyser renders — MX, SPF, DKIM,
# DMARC, MTA-STS, TLS-RPT — and evaluates each one into a pass/warn/fail
# status. The result is the T-0665 DomainCheck payload: `records` keyed by
# family, a `health` map (overall plus per-family), and the ranked
# recommendation explanations. Resolution is read-only: no tenant API is
# called and no DNS record is ever written (SPEC §8, §11.2).
#
# DNS resolution needs no tenant authentication, so this worker connects no
# tenant session and receives no credential block. The BFF supplies a tenant id
# only so the job envelope stays uniform with the other feature workers.
#
# The resolver and selector seams are scriptblocks so Pester can exercise the
# evaluation without live DNS.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:DnsResolverPath = Join-Path -Path $PSScriptRoot -ChildPath '../../../src/M365-Assess/Common/Resolve-DnsRecord.ps1'

if (-not (Get-Command -Name Get-DnsSelectorCandidates -ErrorAction SilentlyContinue)) {
    . (Join-Path -Path $PSScriptRoot -ChildPath 'DnsSelectors.ps1')
}
if (-not (Get-Command -Name Get-DnsRecommendations -ErrorAction SilentlyContinue)) {
    . (Join-Path -Path $PSScriptRoot -ChildPath 'Get-DnsRecommendations.ps1')
}
if (-not (Get-Command -Name Resolve-DnsRecord -ErrorAction SilentlyContinue)) {
    if (Test-Path -LiteralPath $script:DnsResolverPath -PathType Leaf) {
        . $script:DnsResolverPath
    }
}

function Test-OnMicrosoftDomainName {
    <#
    .SYNOPSIS
        True for a Microsoft-managed `.onmicrosoft.com` domain.
    .DESCRIPTION
        ADR-0003 filters these at source: they cannot have customer-published
        DNS records by design, so there is nothing to analyse.
    .PARAMETER Name
        The domain name to test.
    .EXAMPLE
        Test-OnMicrosoftDomainName -Name 'contoso.onmicrosoft.com'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()][AllowEmptyString()][string]$Name = ''
    )

    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    $normalized = $Name.Trim().ToLowerInvariant()
    return $normalized -eq 'onmicrosoft.com' -or $normalized.EndsWith('.onmicrosoft.com')
}

function Get-DnsTxtValues {
    <#
    .SYNOPSIS
        Flattens Resolve-DnsRecord TXT results into complete strings.
    .DESCRIPTION
        Resolve-DnsName returns one object per record with a `Strings` array;
        TXT segments on one record must be concatenated, not joined with spaces.
    .PARAMETER Records
        The raw TXT result objects.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()][AllowNull()][object[]]$Records
    )

    $values = [System.Collections.Generic.List[string]]::new()
    foreach ($record in @($Records)) {
        if ($null -eq $record) { continue }
        if ($record -is [string]) {
            if (-not [string]::IsNullOrWhiteSpace($record)) { $values.Add($record.Trim()) }
            continue
        }
        $stringsProperty = $record.PSObject.Properties['Strings']
        if ($null -eq $stringsProperty -or $null -eq $stringsProperty.Value) { continue }
        $segments = @($stringsProperty.Value | ForEach-Object { [string]$_ })
        if ($segments.Count -gt 0) {
            $values.Add(($segments -join ''))
        }
    }
    return @($values | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Find-DnsTxtValue {
    <#
    .SYNOPSIS
        Returns the first TXT record matching `Pattern`, or an empty string.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()][AllowNull()][object[]]$Records,
        [Parameter(Mandatory)][string]$Pattern
    )

    foreach ($value in (Get-DnsTxtValues -Records $Records)) {
        if ($value -match $Pattern) { return $value }
    }
    return ''
}

function Get-DnsMxTargets {
    <#
    .SYNOPSIS
        Normalises MX results to their target host names.
    .PARAMETER Records
        The raw MX result objects.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()][AllowNull()][object[]]$Records
    )

    $targets = [System.Collections.Generic.List[string]]::new()
    foreach ($record in @($Records)) {
        if ($null -eq $record) { continue }
        $target = ''
        if ($record -is [string]) {
            $target = $record
        }
        else {
            $property = $record.PSObject.Properties['NameExchange']
            if ($null -ne $property -and $null -ne $property.Value) { $target = [string]$property.Value }
        }
        $target = $target.Trim().TrimEnd('.')
        if (-not [string]::IsNullOrWhiteSpace($target)) { $targets.Add($target) }
    }
    return @($targets)
}

function Invoke-DnsLookup {
    <#
    .SYNOPSIS
        Runs one resolver call, treating a lookup failure as "no records".
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)][scriptblock]$Resolve,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Type
    )

    try {
        return @(& $Resolve $Name $Type)
    }
    catch {
        return @()
    }
}

function Get-DnsSpfLookupCount {
    <#
    .SYNOPSIS
        Counts the DNS-lookup mechanisms in an SPF record (RFC 7208 §4.6.4).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter()][AllowEmptyString()][string]$Record = '')

    $count = 0
    foreach ($term in ($Record -split '\s+')) {
        if ($term -match '^(include:|exists:|redirect=)') { $count++ }
        elseif ($term -match '^(a|mx|ptr)(:|$)') { $count++ }
    }
    return $count
}

function Get-DnsDmarcPolicy {
    <#
    .SYNOPSIS
        Returns the DMARC `p=` policy, or an empty string when unset.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter()][AllowEmptyString()][string]$Record = '')

    if ($Record -match '(?i)\bp\s*=\s*(none|quarantine|reject)') {
        return $Matches[1].ToLowerInvariant()
    }
    return ''
}

function Resolve-DomainDkimSelectors {
    <#
    .SYNOPSIS
        Resolves the DKIM selectors published for a domain.
    .DESCRIPTION
        Tries the known selectors in order and keeps the ones that resolve to a
        CNAME. A per-tenant override, when provided, is tried first (SPEC §11.1).
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][string]$Domain,
        [Parameter(Mandatory)][scriptblock]$Resolve,
        [Parameter()][AllowEmptyString()][string]$Override = ''
    )

    $selectors = [System.Collections.Generic.List[string]]::new()
    foreach ($selector in (Get-DnsSelectorCandidates -Override $Override)) {
        $name = "$selector._domainkey.$Domain"
        $records = Invoke-DnsLookup -Resolve $Resolve -Name $name -Type 'CNAME'
        $found = $false
        foreach ($record in $records) {
            if ($null -eq $record) { continue }
            if ($record -is [string]) {
                if (-not [string]::IsNullOrWhiteSpace($record)) { $found = $true }
                continue
            }
            $property = $record.PSObject.Properties['NameHost']
            if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                $found = $true
            }
        }
        if ($found) { $selectors.Add($selector) }
    }
    return @($selectors)
}

function Test-DomainDns {
    <#
    .SYNOPSIS
        Resolves and evaluates a domain's email-authentication DNS records.
    .DESCRIPTION
        Returns the records keyed by family, a per-family health map with an
        overall status, and the recommendation explanations derived from the
        same records. A clean domain yields passing families and no
        recommendations; a missing record yields a failing family, never an
        error. `.onmicrosoft.com` domains return an empty, unknown result.
    .PARAMETER Domain
        The domain to analyse.
    .PARAMETER SelectorOverride
        Optional per-tenant DKIM selector override, tried first.
    .PARAMETER ResolveRecord
        Resolver seam: scriptblock (name, type) -> records. Defaults to the
        module's Resolve-DnsRecord.
    .OUTPUTS
        [pscustomobject] with records, health, and recommendations.
    .EXAMPLE
        Test-DomainDns -Domain 'contoso.com'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter()]
        [AllowEmptyString()]
        [string]$SelectorOverride = '',

        [Parameter()]
        [scriptblock]$ResolveRecord
    )

    $normalized = $Domain.Trim().ToLowerInvariant()

    if (-not $ResolveRecord) {
        $ResolveRecord = {
            param($Name, $Type)
            Resolve-DnsRecord -Name $Name -Type $Type -ErrorAction SilentlyContinue
        }
    }

    if (Test-OnMicrosoftDomainName -Name $normalized) {
        return [pscustomobject]@{
            records         = [ordered]@{}
            health          = [ordered]@{ overall = 'unknown'; families = [ordered]@{} }
            recommendations = @()
        }
    }

    $mxTargets = @(Get-DnsMxTargets -Records (Invoke-DnsLookup -Resolve $ResolveRecord -Name $normalized -Type 'MX'))

    $rootTxt = Invoke-DnsLookup -Resolve $ResolveRecord -Name $normalized -Type 'TXT'
    $spfRecord = Find-DnsTxtValue -Records $rootTxt -Pattern '^v=spf1(\s|$)'
    $spfLookups = Get-DnsSpfLookupCount -Record $spfRecord

    $dmarcTxt = Invoke-DnsLookup -Resolve $ResolveRecord -Name "_dmarc.$normalized" -Type 'TXT'
    $dmarcRecord = Find-DnsTxtValue -Records $dmarcTxt -Pattern '^v=DMARC1(\s|;|$)'
    $dmarcPolicy = Get-DnsDmarcPolicy -Record $dmarcRecord

    $mtaTxt = Invoke-DnsLookup -Resolve $ResolveRecord -Name "_mta-sts.$normalized" -Type 'TXT'
    $mtaRecord = Find-DnsTxtValue -Records $mtaTxt -Pattern '^v=STSv1(\s|;|$)'

    $tlsRptTxt = Invoke-DnsLookup -Resolve $ResolveRecord -Name "_smtp._tls.$normalized" -Type 'TXT'
    $tlsRptRecord = Find-DnsTxtValue -Records $tlsRptTxt -Pattern '^v=TLSRPTv1(\s|;|$)'

    $selectors = @(Resolve-DomainDkimSelectors -Domain $normalized -Resolve $ResolveRecord -Override $SelectorOverride)

    $records = [ordered]@{
        mx     = @($mxTargets)
        spf    = [ordered]@{ record = $spfRecord; lookupCount = $spfLookups }
        dkim   = [ordered]@{
            selectors = @($selectors)
            selector1 = ($selectors -contains 'selector1')
            selector2 = ($selectors -contains 'selector2')
            enabled   = (@($selectors).Count -gt 0)
        }
        dmarc  = [ordered]@{ record = $dmarcRecord; policy = $dmarcPolicy }
        mtaSts = [ordered]@{ present = (-not [string]::IsNullOrWhiteSpace($mtaRecord)); record = $mtaRecord }
        tlsRpt = [ordered]@{ present = (-not [string]::IsNullOrWhiteSpace($tlsRptRecord)); record = $tlsRptRecord }
    }

    $mxStatus = if (@($mxTargets).Count -eq 0) { 'fail' } else { 'pass' }
    $spfStatus = if ([string]::IsNullOrWhiteSpace($spfRecord)) {
        'fail'
    }
    elseif ($spfLookups -gt 10) {
        'fail'
    }
    elseif ($spfRecord -match '(?i)-\s*all\b') {
        'pass'
    }
    else {
        'warn'
    }
    $dkimStatus = if (@($selectors).Count -eq 0) { 'fail' } else { 'pass' }
    $dmarcStatus = if ([string]::IsNullOrWhiteSpace($dmarcRecord)) {
        'fail'
    }
    elseif ($dmarcPolicy -eq 'none') {
        'fail'
    }
    elseif ($dmarcPolicy -eq 'quarantine') {
        'warn'
    }
    else {
        'pass'
    }
    $mtaStatus = if ([string]::IsNullOrWhiteSpace($mtaRecord)) { 'warn' } else { 'pass' }
    $tlsRptStatus = if ([string]::IsNullOrWhiteSpace($tlsRptRecord)) { 'warn' } else { 'pass' }

    $families = [ordered]@{
        mx     = $mxStatus
        spf    = $spfStatus
        dkim   = $dkimStatus
        dmarc  = $dmarcStatus
        mtaSts = $mtaStatus
        tlsRpt = $tlsRptStatus
    }
    $statuses = @($families.Values)
    $overall = if ($statuses -contains 'fail') {
        'unhealthy'
    }
    elseif ($statuses -contains 'warn') {
        'degraded'
    }
    else {
        'healthy'
    }

    $recommendations = @()
    foreach ($recommendation in @(Get-DnsRecommendations -Records $records)) {
        $explanation = [string]$recommendation.explanation
        if (-not [string]::IsNullOrWhiteSpace($explanation)) { $recommendations += $explanation }
    }

    return [pscustomobject]@{
        records         = $records
        health          = [ordered]@{ overall = $overall; families = $families }
        recommendations = @($recommendations)
    }
}

function Read-DomainDnsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Test-DomainDns.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "job envelope not found at '$Path'"
    }

    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }
    $domain = [string]$json.domain
    if ([string]::IsNullOrWhiteSpace($domain)) {
        throw "job envelope '$Path' is missing mandatory 'domain'"
    }
    $selectorProperty = $json.PSObject.Properties['selectorOverride']
    $selectorOverride = if ($null -ne $selectorProperty -and $selectorProperty.Value) {
        [string]$selectorProperty.Value
    }
    else {
        ''
    }

    return @{
        TenantId         = [string]$json.tenantId
        Domain           = $domain
        SelectorOverride = $selectorOverride
    }
}
