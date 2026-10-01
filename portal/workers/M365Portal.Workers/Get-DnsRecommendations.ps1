# Get-DnsRecommendations.ps1 — actionable DNS recommendations (EPIC-034 SPEC.md
# §3.3, §4.2, §11.2; T-0666).
#
# Turns an analysed record set (the T-0664 Test-DomainDns output: records per
# family) into a ranked recommendation list. Each recommendation names the
# record family, a severity, a plain-language explanation, and a remediation
# link; when the module already emits a check for the family the recommendation
# carries that CheckID (DNS-SPF-001 / DNS-DKIM-001 / DNS-DMARC-001 /
# DNS-MX-001) so it can join the EPIC-006 remediation flow. Families with no
# module check (MTA-STS, TLS-RPT) fall back to a portal instruction.
#
# Recommend-only (SPEC §11.2): this worker reads the analysed records and emits
# text; it never resolves DNS, writes a record, or calls a tenant API.

$script:DnsRemediation = @{
    'DMARC' = @{
        CheckId = 'DNS-DMARC-001'
        Url     = 'https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dmarc-configure'
        Portal  = 'Microsoft 365 Defender > Email & collaboration > Policies & rules > Threat policies > Email authentication settings > DMARC.'
    }
    'SPF' = @{
        CheckId = 'DNS-SPF-001'
        Url     = 'https://learn.microsoft.com/en-us/defender-office-365/email-authentication-spf-configure'
        Portal  = 'At your DNS hosting provider, add or update the domain TXT record with the SPF policy.'
    }
    'DKIM' = @{
        CheckId = 'DNS-DKIM-001'
        Url     = 'https://learn.microsoft.com/en-us/microsoft-365/security/office-365-security/email-authentication-dkim-configure'
        Portal  = 'Microsoft 365 Defender > Email & collaboration > Policies & rules > Threat policies > DKIM > select domain > Enable.'
    }
    'MX' = @{
        CheckId = 'DNS-MX-001'
        Url     = 'https://learn.microsoft.com/en-us/microsoft-365/admin/get-help-with-domains/create-dns-records-at-any-dns-hosting-provider'
        Portal  = 'At your DNS hosting provider, point the MX record at <domain>.mail.protection.outlook.com.'
    }
    'MTA-STS' = @{
        CheckId = $null
        Url     = 'https://learn.microsoft.com/en-us/purview/enhancing-mail-flow-with-mta-sts'
        Portal  = 'Publish an MTA-STS policy file and the _mta-sts TXT record at your DNS hosting provider.'
    }
    'TLS-RPT' = @{
        CheckId = $null
        Url     = 'https://www.rfc-editor.org/rfc/rfc8460'
        Portal  = 'Publish a TLS-RPT TXT record at _smtp._tls.<domain> pointing at a reporting mailbox.'
    }
}

function Get-DnsObjectProperty {
    param(
        [Parameter()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Test-DnsObjectProperty {
    param(
        [Parameter()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    if ($null -eq $Object) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
    return ($null -ne $Object.PSObject.Properties[$Name])
}

function Get-DnsRecordText {
    <#
    .SYNOPSIS
        Flattens a record value (string, object with record/text, or a list) to text.
    #>
    param([Parameter()][object]$Value)

    if ($null -eq $Value) { return '' }
    if ($Value -is [string]) { return $Value.Trim() }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($name in @('record', 'text', 'value', 'strings', 'records', 'NameExchange')) {
            if ($Value.Contains($name)) { return (Get-DnsRecordText -Value $Value[$name]) }
        }
        return ''
    }
    foreach ($name in @('record', 'text', 'value', 'strings', 'records', 'NameExchange')) {
        $property = $Value.PSObject.Properties[$name]
        if ($null -ne $property) { return (Get-DnsRecordText -Value $property.Value) }
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = @($Value | ForEach-Object { Get-DnsRecordText -Value $_ } | Where-Object { $_ })
        return ($parts -join ' ')
    }
    return [string]$Value
}

function Test-DnsRecordPresent {
    <#
    .SYNOPSIS
        True when a family value carries at least one record.
    #>
    param([Parameter()][object]$Value)

    if ($null -eq $Value) { return $false }
    if ($Value -is [string]) { return -not [string]::IsNullOrWhiteSpace($Value) }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($name in @('present', 'published', 'exists')) {
            if ($Value.Contains($name) -and $Value[$name] -eq $true) { return $true }
        }
        foreach ($name in @('record', 'text', 'value', 'strings', 'records')) {
            if ($Value.Contains($name)) { return (Test-DnsRecordPresent -Value $Value[$name]) }
        }
        return $false
    }
    $presentProperty = $Value.PSObject.Properties['present']
    if ($null -ne $presentProperty) { return ($presentProperty.Value -eq $true) }
    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($item in $Value) {
            if (Test-DnsRecordPresent -Value $item) { return $true }
        }
        return $false
    }
    return (-not [string]::IsNullOrWhiteSpace([string]$Value))
}

function Get-SpfLookupCount {
    <#
    .SYNOPSIS
        Counts the DNS-lookup mechanisms in an SPF record (RFC 7208 §4.6.4).
    #>
    param([Parameter()][string]$Record)

    $count = 0
    foreach ($term in ($Record -split '\s+')) {
        if ($term -match '^(include:|exists:|redirect=)') { $count++ }
        elseif ($term -match '^(a|mx|ptr)(:|$)') { $count++ }
    }
    return $count
}

function Get-DnsSeverityRank {
    param([Parameter()][string]$Severity)
    switch ($Severity) {
        'high' { return 0 }
        'medium' { return 1 }
        'low' { return 2 }
        default { return 3 }
    }
}

function New-DnsRecommendation {
    param(
        [Parameter(Mandatory)][string]$Family,
        [Parameter(Mandatory)][ValidateSet('high', 'medium', 'low', 'info')][string]$Severity,
        [Parameter(Mandatory)][string]$Explanation
    )

    $remediation = $script:DnsRemediation[$Family]
    return [pscustomobject]@{
        recordFamily   = $Family
        severity       = $Severity
        explanation    = $Explanation
        remediation    = $remediation.Portal
        remediationUrl = $remediation.Url
        checkId        = $remediation.CheckId
    }
}

function Get-DnsRecommendations {
    <#
    .SYNOPSIS
        Ranks actionable recommendations from an analysed DNS record set.
    .DESCRIPTION
        Evaluates each record family present in -Records and returns the
        recommendations ordered by severity (high first) then family. A family
        that is absent from -Records is treated as "not analysed" and skipped;
        a family present but empty is treated as a missing record. A clean
        domain returns an empty list, never an error.
    .PARAMETER Records
        The analysed record set keyed by family (mx, spf, dkim, dmarc, mtaSts,
        tlsRpt). Values may be record text, an object carrying the record, or a
        list of records.
    .OUTPUTS
        [pscustomobject[]] with recordFamily, severity, explanation, remediation,
        remediationUrl, and checkId.
    .EXAMPLE
        Get-DnsRecommendations -Records @{ dmarc = 'v=DMARC1; p=none;' }
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNull()]
        [object]$Records
    )

    $recommendations = New-Object System.Collections.Generic.List[object]

    if (Test-DnsObjectProperty -Object $Records -Name 'dmarc') {
        $record = Get-DnsRecordText -Value (Get-DnsObjectProperty -Object $Records -Name 'dmarc')
        $policy = ''
        if ($record -match '(?i)\bp\s*=\s*(none|quarantine|reject)') { $policy = $Matches[1].ToLowerInvariant() }

        if ([string]::IsNullOrWhiteSpace($record)) {
            $recommendations.Add((New-DnsRecommendation -Family 'DMARC' -Severity 'high' -Explanation 'No DMARC record is published, so receivers cannot act on mail that fails SPF or DKIM.'))
        }
        elseif ($policy -eq 'none') {
            $recommendations.Add((New-DnsRecommendation -Family 'DMARC' -Severity 'high' -Explanation 'DMARC policy is `none`, so failing mail is only monitored and still delivered. Advance to p=quarantine, then p=reject.'))
        }
        elseif ($policy -eq 'quarantine') {
            $recommendations.Add((New-DnsRecommendation -Family 'DMARC' -Severity 'medium' -Explanation 'DMARC policy is `quarantine`; advance to p=reject once reports show no legitimate mail failing.'))
        }
    }

    if (Test-DnsObjectProperty -Object $Records -Name 'spf') {
        $spfValue = Get-DnsObjectProperty -Object $Records -Name 'spf'
        $record = Get-DnsRecordText -Value $spfValue
        $lookupCount = Get-DnsObjectProperty -Object $spfValue -Name 'lookupCount'
        if ($null -eq $lookupCount) { $lookupCount = Get-SpfLookupCount -Record $record }

        if ([string]::IsNullOrWhiteSpace($record)) {
            $recommendations.Add((New-DnsRecommendation -Family 'SPF' -Severity 'high' -Explanation 'No SPF record is published, so receivers cannot verify which servers may send for the domain.'))
        }
        elseif ([int]$lookupCount -gt 10) {
            $recommendations.Add((New-DnsRecommendation -Family 'SPF' -Severity 'high' -Explanation "SPF exceeds 10 DNS lookups ($lookupCount); receivers may treat the record as a permanent error."))
        }
        elseif ($record -notmatch '(?i)-\s*all\b') {
            $recommendations.Add((New-DnsRecommendation -Family 'SPF' -Severity 'medium' -Explanation 'SPF does not end in `-all`, so unauthorised senders are not hard-failed. Use -all once all legitimate senders are listed.'))
        }
    }

    if (Test-DnsObjectProperty -Object $Records -Name 'dkim') {
        $dkimValue = Get-DnsObjectProperty -Object $Records -Name 'dkim'
        $selectors = @()
        $list = Get-DnsObjectProperty -Object $dkimValue -Name 'selectors'
        if ($list) { $selectors += @($list | ForEach-Object { [string]$_ }) }
        foreach ($name in @('selector1', 'selector2')) {
            $value = Get-DnsObjectProperty -Object $dkimValue -Name $name
            if ($value -eq $true -or ($value -is [string] -and $value)) { $selectors += $name }
        }
        if ($selectors.Count -eq 0 -and $dkimValue -is [string] -and $dkimValue) {
            $selectors += @($dkimValue)
        }
        $selectors = @($selectors | Where-Object { $_ } | Select-Object -Unique)

        if ($selectors.Count -eq 0) {
            $recommendations.Add((New-DnsRecommendation -Family 'DKIM' -Severity 'high' -Explanation 'No DKIM selectors are published, so outbound mail is not cryptographically signed.'))
        }
        elseif ((Get-DnsObjectProperty -Object $dkimValue -Name 'enabled') -eq $false) {
            $recommendations.Add((New-DnsRecommendation -Family 'DKIM' -Severity 'medium' -Explanation 'DKIM selectors exist but signing is not enabled in Exchange Online, so mail is still unsigned.'))
        }
    }

    if (Test-DnsObjectProperty -Object $Records -Name 'mx') {
        $mxValue = Get-DnsObjectProperty -Object $Records -Name 'mx'
        if (-not (Test-DnsRecordPresent -Value $mxValue)) {
            $recommendations.Add((New-DnsRecommendation -Family 'MX' -Severity 'high' -Explanation 'No MX record is published, so the domain cannot receive mail.'))
        }
        else {
            $targets = Get-DnsRecordText -Value $mxValue
            if ($targets -notmatch '(?i)mail\.protection\.outlook\.com') {
                $recommendations.Add((New-DnsRecommendation -Family 'MX' -Severity 'medium' -Explanation 'MX does not route to Exchange Online; confirm the relay is intentional or update the record.'))
            }
        }
    }

    foreach ($family in @(@{ Key = 'mtaSts'; Name = 'MTA-STS' }, @{ Key = 'tlsRpt'; Name = 'TLS-RPT' })) {
        if (-not (Test-DnsObjectProperty -Object $Records -Name $family.Key)) { continue }
        $value = Get-DnsObjectProperty -Object $Records -Name $family.Key
        if (-not (Test-DnsRecordPresent -Value $value)) {
            $recommendations.Add((New-DnsRecommendation -Family $family.Name -Severity 'low' -Explanation "$($family.Name) is not published, so transport security cannot be enforced or reported on."))
        }
    }

    return @($recommendations | Sort-Object -Property @{ Expression = { Get-DnsSeverityRank -Severity $_.severity } }, @{ Expression = { $_.recordFamily } })
}

function Read-DnsRecommendationsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-DnsRecommendations.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }

    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    return @{
        TenantId = [string]$json.tenantId
        Domain   = [string]$json.domain
        Records  = if ($null -ne $json.records) { $json.records } else { @{} }
    }
}
