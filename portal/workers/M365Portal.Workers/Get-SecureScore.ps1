# Get-SecureScore.ps1 — EPIC-031 Secure Score read worker (SPEC §2 US-1, §4.1,
# §6, §7, §8; T-0602).
#
# Live Graph reads only (SPEC §8): the latest security/secureScores snapshot
# gives the overall current/max/percentage and the per-control achieved/available
# points, and security/secureScoreControlProfiles supplies the friendly action
# title and impact that the score's controlScores reference by id. Category
# points are aggregated from controlScores. The action-to-check mapping is a BFF
# concern (T-0603); this worker returns actions unmapped. Only GET requests are
# issued.

function Read-SecureScoreJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-SecureScore.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }

    $raw = Get-Content -LiteralPath $Path -Raw
    $json = $raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    return @{ TenantId = [string]$json.tenantId }
}

function Get-SecureScoreValue {
    # Reads a property that the Graph SDK may expose directly or, when its typed
    # model omits the field, only under AdditionalProperties (see the module's
    # Get-SecureScoreReport.ps1). Raw REST reads usually carry it directly.
    param(
        [object]$Object,
        [string[]]$Names,
        [object]$Default = $null
    )

    if ($null -eq $Object) { return $Default }
    foreach ($name in $Names) {
        if ($Object -is [System.Collections.IDictionary]) {
            if ($Object.Contains($name) -and $null -ne $Object[$name]) { return $Object[$name] }
        }
        else {
            $value = $Object.$name
            if ($null -ne $value) { return $value }
        }
    }

    $additional = $null
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains('AdditionalProperties')) { $additional = $Object['AdditionalProperties'] }
    }
    elseif ($null -ne $Object.AdditionalProperties) {
        $additional = $Object.AdditionalProperties
    }
    if ($null -ne $additional) {
        foreach ($name in $Names) {
            if ($additional -is [System.Collections.IDictionary]) {
                if ($additional.Contains($name) -and $null -ne $additional[$name]) { return $additional[$name] }
            }
            else {
                $value = $additional.$name
                if ($null -ne $value) { return $value }
            }
        }
    }
    return $Default
}

function Get-SecureScoreControlProfiles {
    param()

    $profiles = [System.Collections.Generic.List[object]]::new()
    $uri = '/v1.0/security/secureScoreControlProfiles?$top=250'
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        foreach ($controlProfile in @($response.value)) { $profiles.Add($controlProfile) }
        $uri = $response.'@odata.nextLink'
    } while ($uri)
    return @($profiles)
}

function Get-LatestSecureScore {
    param([object[]]$Scores)

    $latest = $null
    $latestDate = [datetime]::MinValue
    foreach ($score in @($Scores)) {
        $created = Get-SecureScoreValue -Object $score -Names @('createdDateTime')
        if ($null -eq $latest) { $latest = $score }
        if ($created) {
            try { $parsed = [datetime]::Parse([string]$created) }
            catch { $parsed = [datetime]::MinValue }
            if ($parsed -ge $latestDate) {
                $latestDate = $parsed
                $latest = $score
            }
        }
    }
    return $latest
}

function Get-SecureScore {
    <#
    .SYNOPSIS
        Reads the latest Secure Score, its category split, and improvement actions.
    .DESCRIPTION
        Read-only. Returns current/max/percentage plus a category breakdown and
        the per-control improvement actions with points achieved/available and
        impact. Actions carry no check mapping (T-0603 owns that).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId
    )

    $scoreResponse = Invoke-MgGraphRequest -Method GET -Uri '/v1.0/security/secureScores?$top=5'
    $latest = Get-LatestSecureScore -Scores @($scoreResponse.value)
    if ($null -eq $latest) {
        return [pscustomobject]@{
            tenantId   = $TenantId
            current    = 0
            max        = 0
            percentage = 0
            categories = @()
            actions    = @()
        }
    }

    $controlProfileMap = @{}
    foreach ($controlProfile in Get-SecureScoreControlProfiles) {
        $id = Get-SecureScoreValue -Object $controlProfile -Names @('id')
        if ($id) { $controlProfileMap[[string]$id] = $controlProfile }
    }

    $categoryMap = @{}
    $actions = [System.Collections.Generic.List[object]]::new()

    foreach ($control in @(Get-SecureScoreValue -Object $latest -Names @('controlScores') -Default @())) {
        $id = [string](Get-SecureScoreValue -Object $control -Names @('controlName', 'id'))
        $controlProfile = if ($id -and $controlProfileMap.ContainsKey($id)) { $controlProfileMap[$id] } else { $null }

        $category = Get-SecureScoreValue -Object $control -Names @('controlCategory')
        if (-not $category) { $category = Get-SecureScoreValue -Object $controlProfile -Names @('controlCategory') }
        if (-not $category) { $category = 'Uncategorized' }
        $category = [string]$category

        $achieved = [double](Get-SecureScoreValue -Object $control -Names @('score') -Default 0)
        $available = [double](Get-SecureScoreValue -Object $control -Names @('maxScore') -Default 0)
        if ($available -le 0 -and $controlProfile) {
            $available = [double](Get-SecureScoreValue -Object $controlProfile -Names @('maxScore') -Default 0)
        }

        $title = Get-SecureScoreValue -Object $controlProfile -Names @('title')
        if (-not $title) { $title = $id }
        $impact = Get-SecureScoreValue -Object $control -Names @('userImpact')
        if (-not $impact) { $impact = Get-SecureScoreValue -Object $controlProfile -Names @('userImpact') }
        if (-not $impact) { $impact = 'N/A' }
        $implementationStatus = Get-SecureScoreValue -Object $control -Names @('implementationStatus') -Default 'N/A'

        if (-not $categoryMap.ContainsKey($category)) {
            $categoryMap[$category] = @{ achieved = 0.0; available = 0.0 }
        }
        $entry = $categoryMap[$category]
        $entry.achieved = $entry.achieved + $achieved
        $entry.available = $entry.available + $available

        $actions.Add([pscustomobject]@{
            id                   = $id
            title                = [string]$title
            category             = $category
            pointsAchieved       = [math]::Round($achieved, 2)
            pointsAvailable      = [math]::Round($available, 2)
            impact               = [string]$impact
            implementationStatus = [string]$implementationStatus
        })
    }

    $categories = foreach ($key in ($categoryMap.Keys | Sort-Object)) {
        $entry = $categoryMap[$key]
        $percentage = if ($entry.available -gt 0) {
            [math]::Round(($entry.achieved / $entry.available) * 100, 2)
        }
        else { 0 }
        [pscustomobject]@{
            category   = [string]$key
            achieved   = [math]::Round($entry.achieved, 2)
            available  = [math]::Round($entry.available, 2)
            percentage = $percentage
        }
    }

    $current = [double](Get-SecureScoreValue -Object $latest -Names @('currentScore') -Default 0)
    $max = [double](Get-SecureScoreValue -Object $latest -Names @('maxScore') -Default 0)
    $percentage = if ($max -gt 0) { [math]::Round(($current / $max) * 100, 2) } else { 0 }

    return [pscustomobject]@{
        tenantId   = $TenantId
        current    = [math]::Round($current, 2)
        max        = [math]::Round($max, 2)
        percentage = $percentage
        categories = @($categories)
        actions    = @($actions)
    }
}
