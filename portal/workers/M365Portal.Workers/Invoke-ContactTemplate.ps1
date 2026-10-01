# Invoke-ContactTemplate.ps1 — EPIC-023 contact template shape worker
# (SPEC §2 US-2, §3.2, §5; T-0446).
#
# Contact templates define contact properties and deploy variables per target.
# They carry no tenant writes and touch no M365 service, so this handler never
# opens a Graph or EXO session: it validates the template shape, normalizes the
# `properties`/`variables` maps, and returns the record the BFF persists through
# the T-0441 repository. Invalid shapes are refused with a structured
# `contact-template.invalid` error and are never returned for persistence.

function Get-ContactTemplateFields {
    <#
    .SYNOPSIS
        Returns the template fields this handler understands.
    .DESCRIPTION
        The single source of truth for the §5 ContactTemplate shape. Anything
        outside this set is ignored, not persisted.
    .EXAMPLE
        Get-ContactTemplateFields
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('id', 'name', 'properties', 'variables')
}

function Test-ContactTemplateMap {
    <#
    .SYNOPSIS
        Reports whether a value is a JSON object (dictionary) shape.
    .PARAMETER Value
        The value to test. A hashtable or IDictionary is accepted; $null, a
        scalar, or an array is not.
    .EXAMPLE
        Test-ContactTemplateMap -Value $Template.properties
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [object]$Value = $null
    )

    if ($null -eq $Value) {
        return $false
    }
    return ($Value -is [System.Collections.IDictionary])
}

function Get-ContactTemplateIssues {
    <#
    .SYNOPSIS
        Validates a contact template shape and returns structured issues.
    .DESCRIPTION
        Collects every shape problem as `{ field; reason }` so the caller can
        report them together. An empty array means the template is valid.
        `name` must be a non-empty string, `properties` must be a JSON object,
        and `variables`, when supplied, must be a JSON object.
    .PARAMETER Name
        The template name.
    .PARAMETER Properties
        The contact property map.
    .PARAMETER Variables
        The deploy variable map. Omit ($null) when the template declares none.
    .EXAMPLE
        Get-ContactTemplateIssues -Name 'Vendor' -Properties @{ displayName = 'Vendor' }
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter()]
        [object]$Name = $null,

        [Parameter()]
        [object]$Properties = $null,

        [Parameter()]
        [object]$Variables = $null
    )

    $issues = [System.Collections.Generic.List[object]]::new()

    if ($Name -isnot [string] -or [string]::IsNullOrWhiteSpace($Name)) {
        $issues.Add([pscustomobject]@{ field = 'name'; reason = 'must be a non-empty string' })
    }

    if (-not (Test-ContactTemplateMap -Value $Properties)) {
        $issues.Add([pscustomobject]@{ field = 'properties'; reason = 'must be a JSON object' })
    }

    if ($null -ne $Variables -and -not (Test-ContactTemplateMap -Value $Variables)) {
        $issues.Add([pscustomobject]@{ field = 'variables'; reason = 'must be a JSON object' })
    }

    return @($issues)
}

function Invoke-ContactTemplate {
    <#
    .SYNOPSIS
        Validates and normalizes a contact template for persistence.
    .DESCRIPTION
        Checks the §5 shape with Get-ContactTemplateIssues and throws
        `contact-template.invalid` when anything is wrong, so an invalid
        template is never returned for persistence. A valid template is
        returned with `properties`/`variables` preserved unchanged, plus a
        `valid` flag the caller can assert on.
    .PARAMETER TemplateId
        Existing template id on update; empty on create so the BFF assigns one.
    .PARAMETER Name
        The template name.
    .PARAMETER Properties
        The contact property map.
    .PARAMETER Variables
        The deploy variable map. Omit ($null) when the template declares none.
    .EXAMPLE
        Invoke-ContactTemplate -Name 'Vendor' -Properties @{ displayName = 'Vendor' }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$TemplateId = '',

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$Properties,

        [Parameter()]
        [object]$Variables = $null
    )

    $issues = Get-ContactTemplateIssues -Name $Name -Properties $Properties -Variables $Variables
    if ($issues.Count -gt 0) {
        $summary = ($issues | ForEach-Object { "$($_.field): $($_.reason)" }) -join '; '
        throw "contact-template.invalid: invalid contact template: $summary"
    }

    $variables = if ($null -eq $Variables) { @{} } else { $Variables }

    return [pscustomobject]@{
        id         = $TemplateId
        name       = $Name.Trim()
        properties = $Properties
        variables  = $variables
        valid      = $true
    }
}

function Read-ContactTemplateJob {
    <#
    .SYNOPSIS
        Reads a contact template job envelope into Invoke-ContactTemplate parameters.
    .DESCRIPTION
        Validates the envelope schema version and the §5 shape, then returns the
        template id, name, properties, and variables. The envelope carries the
        template only — no tenant id, no credential material, and no tenant
        write.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ContactTemplateJob -Path './run/contact-template-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Contact template job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Contact template job has unsupported schemaVersion: $($job['schemaVersion'])"
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }

    $properties = $payload['properties']
    $variables = if ($payload.ContainsKey('variables')) { $payload['variables'] } else { $null }

    $issues = Get-ContactTemplateIssues -Name $payload['name'] -Properties $properties -Variables $variables
    if ($issues.Count -gt 0) {
        $summary = ($issues | ForEach-Object { "$($_.field): $($_.reason)" }) -join '; '
        throw "contact-template.invalid: invalid contact template: $summary"
    }

    return @{
        TemplateId = [string]$payload['id']
        Name       = [string]$payload['name']
        Properties = $properties
        Variables  = $variables
    }
}
