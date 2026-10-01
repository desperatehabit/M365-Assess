# Invoke-DomainAnalysisSchedule.ps1 — EPIC-034 scheduled domain analysis
# (SPEC §3.4, §4.3, §5; T-0667).
#
# The EPIC-007 scheduler (T-0123) invokes this worker once per tenant. It walks
# the prefetched verified domains, runs the T-0664 analyser for each, and
# persists one T-0661 DomainCheck per domain through the injected repository
# seam. Per ADR-0003 the accepted-domain list is consumed from the prefetch and
# never re-derived mid-run, and `.onmicrosoft.com` domains are filtered at
# source. Unverified, expired, and removed domains are skipped, and a domain
# whose analysis fails mid-run is skipped rather than failing the whole run.
#
# The worker persists history; the change event is produced by the BFF's
# dns-change-detect.ts diffing each persisted check against the prior check.
# Every tenant-touching dependency is an injectable seam so the unit tests run
# without Graph, DNS, or a database.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-DomainAnalysisProperty {
    <#
    .SYNOPSIS
        Reads a property from a hashtable/dictionary or a PSCustomObject.
    #>
    [CmdletBinding()]
    param(
        [Parameter()][AllowNull()][object]$Object,
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

function Test-OnMicrosoftDomain {
    <#
    .SYNOPSIS
        True when the domain is a Microsoft-managed `.onmicrosoft.com` domain.
    .DESCRIPTION
        ADR-0003 filters these at source: they cannot have customer-published
        DNS records by design, so resolving them is wasted work.
    .PARAMETER Name
        The domain name to test.
    .EXAMPLE
        Test-OnMicrosoftDomain -Name 'contoso.onmicrosoft.com'
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

function Get-DomainAnalysisSkipReason {
    <#
    .SYNOPSIS
        Returns the reason a domain is skipped, or '' when it is analysable.
    .DESCRIPTION
        Only verified, non-initial, non-expired, non-removed public domains are
        analysed. `.onmicrosoft.com` is excluded per ADR-0003.
    .PARAMETER Domain
        A domain object from the prefetched accepted-domain list.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()][AllowNull()][object]$Domain
    )

    $name = [string](Get-DomainAnalysisProperty -Object $Domain -Name 'name')
    if ([string]::IsNullOrWhiteSpace($name)) { return 'missing_name' }
    if (Test-OnMicrosoftDomain -Name $name) { return 'onmicrosoft' }

    $verification = [string](Get-DomainAnalysisProperty -Object $Domain -Name 'verification')
    $status = [string](Get-DomainAnalysisProperty -Object $Domain -Name 'status')

    if ($verification -match '^(expired|removed)$') { return $verification.ToLowerInvariant() }
    if ($status -match '^(expired|removed)$') { return $status.ToLowerInvariant() }
    if ((Get-DomainAnalysisProperty -Object $Domain -Name 'expired') -eq $true) { return 'expired' }
    if ((Get-DomainAnalysisProperty -Object $Domain -Name 'removed') -eq $true) { return 'removed' }
    if ((Get-DomainAnalysisProperty -Object $Domain -Name 'isInitial') -eq $true) { return 'initial' }

    if ((Get-DomainAnalysisProperty -Object $Domain -Name 'isVerified') -eq $true) { return '' }
    if ($verification -eq 'verified') { return '' }
    return 'unverified'
}

function Read-DomainAnalysisScheduleJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope into Invoke-DomainAnalysisSchedule parameters.
    .DESCRIPTION
        The envelope carries the prefetched domains and the prior checks (one
        per domain) so the worker never re-derives the accepted-domain list
        mid-run (ADR-0003). The envelope carries references only; no secret is
        present and none is needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-DomainAnalysisScheduleJob -Path './run/domain-analysis-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Domain analysis job file not found: $Path"
    }
    # -DateKind String keeps the ISO-8601 `at` the BFF wrote instead of
    # re-rendering it in the host locale.
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable -DateKind String
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Domain analysis job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Domain analysis job is missing required field: tenantId'
    }
    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) { $payload = @{} }

    $domains = @()
    if ($null -ne $payload['domains']) { $domains = @($payload['domains']) }
    $priorChecks = @()
    if ($null -ne $payload['priorChecks']) { $priorChecks = @($payload['priorChecks']) }

    return @{
        TenantId      = $tenantId
        Domains       = $domains
        PriorChecks   = $priorChecks
        At            = [string]$payload['at']
        CorrelationId = [string]$job['correlationId']
    }
}

function Invoke-DomainAnalysisSchedule {
    <#
    .SYNOPSIS
        Runs the scheduled domain analysis for one tenant.
    .DESCRIPTION
        Iterates the prefetched verified domains, runs the T-0664 analyser for
        each, and appends one T-0661 DomainCheck through the repository seam.
        Unverified/expired/removed domains and `.onmicrosoft.com` domains are
        skipped (ADR-0003), and a per-domain analysis failure is skipped rather
        than failing the run. Returns the persisted checks with the prior check
        each replaced, so the caller can diff them with dns-change-detect.
    .PARAMETER TenantId
        The tenant being analysed.
    .PARAMETER Domains
        The prefetched accepted-domain objects (ADR-0003). Each carries a name
        and its verification state.
    .PARAMETER PriorChecks
        The prior DomainCheck per domain, matched on `domain`.
    .PARAMETER Analyse
        T-0664 analyser seam: scriptblock (domain) -> records/health/recommendations.
    .PARAMETER CheckRepo
        T-0661 repository seam. Must expose AppendDomainCheck(input) -> check.
    .PARAMETER At
        ISO-8601 run timestamp; defaults to the current UTC instant.
    .PARAMETER CorrelationId
        Correlation id carried onto the persisted checks.
    .PARAMETER NewCheckId
        Id generator seam; defaults to a new GUID.
    .OUTPUTS
        [PSCustomObject] with TenantId, Results (Domain/Check/Prior), and Skipped
        (Domain/Reason).
    .EXAMPLE
        Invoke-DomainAnalysisSchedule -TenantId 'tenant-a' -Domains $domains `
            -Analyse { param($d) ... } -CheckRepo $repo
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Domains,

        [Parameter()]
        [AllowEmptyCollection()]
        [object[]]$PriorChecks = @(),

        [Parameter(Mandatory)]
        [scriptblock]$Analyse,

        [Parameter(Mandatory)]
        [object]$CheckRepo,

        [Parameter()]
        [string]$At = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$NewCheckId
    )

    if ([string]::IsNullOrWhiteSpace($At)) {
        $At = [System.DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'.'fff'Z'")
    }
    if (-not $NewCheckId) { $NewCheckId = { [guid]::NewGuid().ToString() } }

    $appendMethod = $CheckRepo.PSObject.Methods['AppendDomainCheck']
    if ($null -eq $appendMethod) {
        throw 'domain-analysis.check_repo_invalid: CheckRepo must expose AppendDomainCheck(input)'
    }

    $priorByDomain = @{}
    foreach ($prior in @($PriorChecks)) {
        $priorDomain = [string](Get-DomainAnalysisProperty -Object $prior -Name 'domain')
        if (-not [string]::IsNullOrWhiteSpace($priorDomain)) {
            $key = $priorDomain.Trim().ToLowerInvariant()
            if (-not $priorByDomain.ContainsKey($key)) { $priorByDomain[$key] = $prior }
        }
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $skipped = [System.Collections.Generic.List[object]]::new()

    foreach ($domain in @($Domains)) {
        $name = [string](Get-DomainAnalysisProperty -Object $domain -Name 'name')
        $reason = Get-DomainAnalysisSkipReason -Domain $domain
        if ($reason) {
            $skipped.Add([pscustomobject]@{ Domain = $name; Reason = $reason })
            continue
        }

        try {
            $analysis = & $Analyse $name
        }
        catch {
            $skipped.Add([pscustomobject]@{
                Domain = $name
                Reason = 'analysis_failed'
                Error  = $_.Exception.Message
            })
            continue
        }

        $checkId = [string](& $NewCheckId)
        $checkInput = [ordered]@{
            id              = $checkId
            tenantId        = $TenantId
            domain          = $name
            at              = $At
            records         = (Get-DomainAnalysisProperty -Object $analysis -Name 'records')
            health          = (Get-DomainAnalysisProperty -Object $analysis -Name 'health')
            recommendations = @((Get-DomainAnalysisProperty -Object $analysis -Name 'recommendations'))
        }

        $persisted = $CheckRepo.AppendDomainCheck($checkInput)
        if ($null -eq $persisted) { $persisted = $checkInput }

        $key = $name.Trim().ToLowerInvariant()
        $prior = $null
        if ($priorByDomain.ContainsKey($key)) { $prior = $priorByDomain[$key] }

        $results.Add([pscustomobject]@{
            Domain = $name
            Check  = $persisted
            Prior  = $prior
        })
    }

    return [pscustomobject]@{
        TenantId      = $TenantId
        CorrelationId = $CorrelationId
        Results       = @($results)
        Skipped       = @($skipped)
    }
}
