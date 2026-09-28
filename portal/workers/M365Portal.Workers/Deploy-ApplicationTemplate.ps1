# Deploy-ApplicationTemplate.ps1 - EPIC-017 application template deploy preflight (SPEC section 3.3, section 8; T-0327).
#
# Read-only. For one target tenant:
# - Substitutes %name% tokens in every string of the template config with the values the BFF
#   resolved for that tenant (EPIC-002 semantics: an unknown token is an issue, never an
#   empty string). Only non-secret values ever reach this worker.
# - Looks for an existing Intune app with the resolved display name and reports it as a
#   conflict, so a template deploy never silently creates a duplicate.
# The BFF validates the resolved request and queues it through the AppDeployment path (T-0323);
# this worker performs no tenant writes.

$script:AppTemplateTokenPattern = '%([A-Za-z0-9_][A-Za-z0-9_.-]*)%'

function Read-ApplicationTemplateJob {
    <#
    .SYNOPSIS
        Parses a job document for Deploy-ApplicationTemplate.
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
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    foreach ($field in @('tenantId', 'config')) {
        if (-not $json[$field]) { throw "job envelope '$Path' is missing mandatory '$field'" }
    }
    return @{
        TenantId = [string]$json['tenantId']
        Config   = $json['config']
        Values   = if ($json['values']) { $json['values'] } else { @{} }
    }
}

function Resolve-AppTemplateValue {
    <#
    .SYNOPSIS
        Returns a copy of a config value with %name% tokens replaced; unknown tokens are collected.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [object]$Value,
        [Parameter(Mandatory)][hashtable]$Values,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$Unknown
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        return [regex]::Replace($Value, $script:AppTemplateTokenPattern, {
                param($match)
                $name = $match.Groups[1].Value
                if ($Values.ContainsKey($name)) { return [string]$Values[$name] }
                $null = $Unknown.Add($name)
                return $match.Value
            })
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) { $copy[$key] = Resolve-AppTemplateValue -Value $Value[$key] -Values $Values -Unknown $Unknown }
        return $copy
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        return , @(foreach ($item in $Value) { Resolve-AppTemplateValue -Value $item -Values $Values -Unknown $Unknown })
    }
    return $Value
}

function Invoke-ApplicationTemplatePreflight {
    <#
    .SYNOPSIS
        Substitutes a template's variables for one tenant and checks for an existing app of that name.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [hashtable]$Values = @{}
    )

    $unknown = [System.Collections.Generic.HashSet[string]]::new()
    $request = Resolve-AppTemplateValue -Value $Config -Values $Values -Unknown $unknown
    $issues = [System.Collections.Generic.List[string]]::new()
    foreach ($name in ($unknown | Sort-Object)) {
        $issues.Add("unknown tenant variable '%$name%'")
    }

    $displayName = [string]$request['displayName']
    $conflict = $false
    $existingAppId = $null
    if (-not $displayName) {
        $issues.Add('the template has no displayName')
    }
    elseif ($unknown.Count -eq 0) {
        $escaped = $displayName.Replace("'", "''")
        $filter = [uri]::EscapeDataString("displayName eq '$escaped'")
        $response = Invoke-MgGraphRequest -Method GET -Uri "/beta/deviceAppManagement/mobileApps?`$filter=$filter&`$select=id,displayName"
        $found = @($response['value'] | Where-Object { $_ }) | Select-Object -First 1
        if ($found) {
            $conflict = $true
            $existingAppId = [string]$found['id']
        }
    }

    return @{
        tenantId      = $TenantId
        request       = $request
        conflict      = $conflict
        existingAppId = $existingAppId
        issues        = @($issues)
    }
}
