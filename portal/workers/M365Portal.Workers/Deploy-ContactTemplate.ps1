# Deploy-ContactTemplate.ps1 — EPIC-023 contact template deploy worker
# (SPEC §3.2, §4.2, §6, §7, §8; T-0447).
#
# Resolves a ContactTemplate's `properties` against its `variables` plus each
# target's variables, builds a plan preview, and applies the valid targets one
# at a time through the EPIC-006 gated executor (Invoke-ContactAction). A target
# is one contact to create in one tenant and carries its own variable values, so
# a template like `{ displayName = '{name}', externalAddress = '{address}' }`
# can be deployed to many targets. Every target gets exactly one result — ready,
# invalid, created, or failed — so an invalid address or a failed apply never
# aborts its siblings. Preview performs no tenant write and no audit; every
# applied target is audited through the -WriteAudit seam. The EXO session is
# connected by the entrypoint after materializing the tenant credential
# in-process; this file never touches secrets.

function Get-ContactTemplateValue {
    <#
    .SYNOPSIS
        Reads a property from a hashtable or a PSCustomObject.
    .PARAMETER Object
        The object to read from.
    .PARAMETER Name
        The property name.
    .EXAMPLE
        Get-ContactTemplateValue -Object $target -Name 'tenantId'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Object = $null,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary]) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) {
        return $property.Value
    }
    return $null
}

function Resolve-ContactTemplateString {
    <#
    .SYNOPSIS
        Substitutes `{variable}` tokens in a string.
    .DESCRIPTION
        Replaces every token whose name matches a key in $Variables with the
        stringified value. Unknown tokens are left untouched so a missing
        variable surfaces as an unresolved placeholder rather than silently
        becoming an empty string.
    .PARAMETER Value
        The source string.
    .PARAMETER Variables
        The resolved variable map.
    .EXAMPLE
        Resolve-ContactTemplateString -Value '{name} Vendor' -Variables @{ name = 'Acme' }
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$Value = '',

        [Parameter()]
        [hashtable]$Variables = @{}
    )

    if ($null -eq $Value) {
        return ''
    }
    $result = $Value
    foreach ($key in $Variables.Keys) {
        $token = '{' + [string]$key + '}'
        $result = $result.Replace($token, [string]$Variables[$key])
    }
    return $result
}

function Resolve-ContactTemplateValue {
    <#
    .SYNOPSIS
        Recursively substitutes variables into a property value.
    .PARAMETER Value
        A string, map, or array.
    .PARAMETER Variables
        The resolved variable map.
    .EXAMPLE
        Resolve-ContactTemplateValue -Value @{ displayName = '{name}' } -Variables @{ name = 'Acme' }
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Value = $null,

        [Parameter()]
        [hashtable]$Variables = @{}
    )

    if ($Value -is [string]) {
        return (Resolve-ContactTemplateString -Value $Value -Variables $Variables)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $map = @{}
        foreach ($key in $Value.Keys) {
            $map[[string]$key] = Resolve-ContactTemplateValue -Value $Value[$key] -Variables $Variables
        }
        return $map
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        return , @(foreach ($item in $Value) {
                Resolve-ContactTemplateValue -Value $item -Variables $Variables
            })
    }
    return $Value
}

function Resolve-ContactTemplateProperties {
    <#
    .SYNOPSIS
        Resolves every template property against the variable map.
    .PARAMETER Properties
        The template property map (hashtable or PSCustomObject).
    .PARAMETER Variables
        The resolved variable map.
    .EXAMPLE
        Resolve-ContactTemplateProperties -Properties $template.properties -Variables @{ name = 'Acme' }
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter()]
        [object]$Properties = $null,

        [Parameter()]
        [hashtable]$Variables = @{}
    )

    $map = @{}
    if ($Properties -is [System.Collections.IDictionary]) {
        foreach ($key in $Properties.Keys) {
            $map[[string]$key] = Resolve-ContactTemplateValue -Value $Properties[$key] -Variables $Variables
        }
    }
    elseif ($null -ne $Properties) {
        foreach ($property in $Properties.PSObject.Properties) {
            $map[$property.Name] = Resolve-ContactTemplateValue -Value $property.Value -Variables $Variables
        }
    }
    return $map
}

function Merge-ContactTemplateVariables {
    <#
    .SYNOPSIS
        Merges template defaults with a target's variable overrides.
    .DESCRIPTION
        Target variables win over template variables so one template can define
        defaults while a target customises only what it needs.
    .PARAMETER TemplateVariables
        The template's default variable map.
    .PARAMETER TargetVariables
        The target's variable map.
    .EXAMPLE
        Merge-ContactTemplateVariables -TemplateVariables @{ region = 'eu' } -TargetVariables @{ region = 'us' }
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter()]
        [object]$TemplateVariables = $null,

        [Parameter()]
        [object]$TargetVariables = $null
    )

    $merged = @{}
    foreach ($source in @($TemplateVariables, $TargetVariables)) {
        if ($null -eq $source) {
            continue
        }
        if ($source -is [System.Collections.IDictionary]) {
            foreach ($key in $source.Keys) {
                $merged[[string]$key] = $source[$key]
            }
        }
        else {
            foreach ($property in $source.PSObject.Properties) {
                $merged[$property.Name] = $property.Value
            }
        }
    }
    return $merged
}

function Test-ContactTemplateAddress {
    <#
    .SYNOPSIS
        Tests whether an external address is a plausible SMTP address.
    .PARAMETER Address
        The raw external address.
    .EXAMPLE
        Test-ContactTemplateAddress -Address 'vendor@example.invalid'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [string]$Address = ''
    )

    if ([string]::IsNullOrWhiteSpace($Address)) {
        return $false
    }
    $candidate = $Address.Trim()
    if ($candidate -match '^(?i)smtp:') {
        $candidate = $candidate.Substring(5).Trim()
    }
    return $candidate -match '^[^@\s]+@[^@\s]+\.[^@\s]+$'
}

function Resolve-ContactTemplateTarget {
    <#
    .SYNOPSIS
        Resolves one deploy target into the contact it will create.
    .DESCRIPTION
        Merges the template variables with the target's variables, substitutes
        them into the template properties, and validates the resolved contact.
        Returns the resolved contact plus a `valid` flag and the collected
        issues, so an invalid target is reported rather than thrown.
    .PARAMETER Template
        The ContactTemplate (id, name, properties, variables).
    .PARAMETER Target
        One deploy target carrying tenantId and optional variables.
    .EXAMPLE
        Resolve-ContactTemplateTarget -Template $template -Target @{ tenantId = 'tenant-a'; variables = @{ name = 'Acme' } }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Template,

        [Parameter(Mandatory)]
        [object]$Target
    )

    $tenantId = ([string](Get-ContactTemplateValue -Object $Target -Name 'tenantId')).Trim()
    $templateVariables = Get-ContactTemplateValue -Object $Template -Name 'variables'
    $targetVariables = Get-ContactTemplateValue -Object $Target -Name 'variables'
    $propertiesRaw = Get-ContactTemplateValue -Object $Template -Name 'properties'

    $variables = Merge-ContactTemplateVariables -TemplateVariables $templateVariables -TargetVariables $targetVariables
    $properties = Resolve-ContactTemplateProperties -Properties $propertiesRaw -Variables $variables

    $displayName = ([string](Get-ContactTemplateValue -Object $properties -Name 'displayName')).Trim()
    $externalAddress = ([string](Get-ContactTemplateValue -Object $properties -Name 'externalAddress')).Trim()
    $type = ([string](Get-ContactTemplateValue -Object $properties -Name 'type')).Trim()
    if ([string]::IsNullOrWhiteSpace($type)) {
        $type = 'mailContact'
    }
    $hiddenRaw = Get-ContactTemplateValue -Object $properties -Name 'hiddenFromGal'
    $hidden = ($hiddenRaw -eq $true) -or (([string]$hiddenRaw).Trim().ToLowerInvariant() -eq 'true')

    $issues = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        $issues.Add('tenantId is required')
    }
    if ([string]::IsNullOrWhiteSpace($displayName)) {
        $issues.Add('displayName is required')
    }
    if ([string]::IsNullOrWhiteSpace($externalAddress)) {
        $issues.Add('externalAddress is required')
    }
    elseif (-not (Test-ContactTemplateAddress -Address $externalAddress)) {
        $issues.Add("externalAddress '$externalAddress' is not a valid email address")
    }
    if ($type -ne 'mailContact' -and $type -ne 'mailUser') {
        $issues.Add("type '$type' must be one of: mailContact, mailUser")
    }

    return [pscustomobject]@{
        tenantId        = $tenantId
        variables       = $variables
        properties      = $properties
        displayName     = $displayName
        externalAddress = $externalAddress
        type            = $type
        hiddenFromGal   = $hidden
        valid           = ($issues.Count -eq 0)
        issues          = @($issues)
    }
}

function Invoke-DeployContactTemplate {
    <#
    .SYNOPSIS
        Plans or applies a contact template deployment per target.
    .DESCRIPTION
        Resolves every target and returns one result each. -DryRun returns the
        resolved contacts as `ready`/`invalid` with no tenant write and no
        audit. An apply routes every valid target through Invoke-ContactAction
        (the EPIC-006 gated executor) one at a time, so a failed target is
        reported with its error while its siblings still succeed; the successes
        are never hidden by the failure. Returns the per-target results, an
        aggregate summary, and the collected audit events.
    .PARAMETER Template
        The ContactTemplate (id, name, properties, variables).
    .PARAMETER Targets
        Deploy targets. Each target carries a tenantId and optional variables.
    .PARAMETER DryRun
        Plan only: no tenant write, no audit.
    .PARAMETER Actor
        Caller identity recorded on each audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on each audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-DeployContactTemplate -Template $template -Targets $targets -DryRun
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Template,

        [Parameter()]
        [object[]]$Targets = @(),

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [string]$Actor = 'system',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $templateId = [string](Get-ContactTemplateValue -Object $Template -Name 'id')
    $Targets = @($Targets | Where-Object { $null -ne $_ })
    if ($Targets.Count -eq 0) {
        return @{
            error      = 'contact-template.validation_failed'
            message    = 'at least one deploy target is required'
            statusCode = 400
        }
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $sink = $WriteAudit
    $collected = [System.Collections.Generic.List[object]]::new()
    $captureAudit = { param($AuditEvent) $collected.Add($AuditEvent); & $sink $AuditEvent }

    foreach ($target in $Targets) {
        $resolved = Resolve-ContactTemplateTarget -Template $Template -Target $target
        $result = @{
            tenantId        = $resolved.tenantId
            displayName     = $resolved.displayName
            externalAddress = $resolved.externalAddress
            type            = $resolved.type
            status          = 'created'
            reason          = $null
            contactId       = $null
        }

        if (-not $resolved.valid) {
            $result.status = 'invalid'
            $result.reason = ($resolved.issues -join '; ')
            $results.Add($result)
            continue
        }

        if ($DryRun) {
            $result.status = 'ready'
            $results.Add($result)
            continue
        }

        $outcome = Invoke-ContactAction -TenantId $resolved.tenantId -Action 'create' -DisplayName $resolved.displayName -ExternalAddress $resolved.externalAddress -Type $resolved.type -HiddenFromGal $resolved.hiddenFromGal -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $captureAudit
        if ($outcome.success -eq $true) {
            $result.status = 'created'
            if ($outcome.auditEvent -and $outcome.auditEvent.contactId) {
                $result.contactId = [string]$outcome.auditEvent.contactId
            }
        }
        else {
            $result.status = 'failed'
            $result.reason = [string]$outcome.error
        }
        $results.Add($result)
    }

    $count = { param($status) @($results | Where-Object { $_.status -eq $status }).Count }
    $created = & $count 'created'
    $ready = & $count 'ready'
    $failed = & $count 'failed'
    $invalid = & $count 'invalid'

    $state = 'succeeded'
    if (($failed + $invalid) -gt 0) {
        $state = if (($created + $ready) -gt 0) { 'partial' } else { 'failed' }
    }

    return @{
        templateId  = $templateId
        preview     = [bool]$DryRun
        targets     = @($results)
        state       = $state
        summary     = @{
            total   = $results.Count
            created = $created
            ready   = $ready
            failed  = $failed
            invalid = $invalid
        }
        auditEvents = @($collected)
    }
}

function Read-DeployContactTemplateJob {
    <#
    .SYNOPSIS
        Reads a contact template deploy job envelope into worker parameters.
    .DESCRIPTION
        Validates the envelope schema version, requires a template and at least
        one target, and returns them with the dry-run and audit fields. The
        envelope carries references only; secrets are never present and never
        needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-DeployContactTemplateJob -Path './run/contact-template-deploy-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Contact template deploy job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Contact template deploy job has unsupported schemaVersion: $($job['schemaVersion'])"
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }

    $template = $payload['template']
    if ($null -eq $template) {
        throw 'Contact template deploy job is missing required field: payload.template'
    }

    $targets = @()
    $rawTargets = $payload['targets']
    if ($null -ne $rawTargets -and $rawTargets -isnot [string] -and $rawTargets -is [System.Collections.IEnumerable]) {
        $targets = @($rawTargets)
    }
    $tenantId = [string]$job['tenantId']
    if ($targets.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($tenantId)) {
        $targets = @(@{ tenantId = $tenantId; variables = $payload['variables'] })
    }
    if ($targets.Count -eq 0) {
        throw 'Contact template deploy job is missing required field: payload.targets'
    }

    return @{
        Template      = $template
        Targets       = $targets
        DryRun        = ($payload['dryRun'] -eq $true)
        Actor         = [string]$payload['actor']
        CorrelationId = [string]$job['correlationId']
    }
}
