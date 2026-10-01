# Deploy-TransportTemplate.ps1 — EPIC-021 transport template deploy worker
# (SPEC §2 US-2/US-4, §3.3, §4.2, §5, §9; T-0406).
#
# Deploys one transport-rule or connector template to one target tenant (the BFF
# fans out across targets and reports partial failures per target):
# - Resolves the template's declared %name% variables (domains, IPs, action
#   overrides) into ruleJson/connectorJson; a missing required variable throws
#   before any write, so a missing variable is never a partial apply.
# - Plans the resolved payload with a diff; -DryRun returns the plan with no
#   tenant write.
# - Applies through the EPIC-006 gate (T-0107): -Confirmed is re-checked here,
#   the apply is delegated to the per-kind worker (Set-TransportRule /
#   Set-Connector), and the returned AuditEvent carries before/after.

function Resolve-TransportTemplateNode {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Value,

        [Parameter(Mandatory)]
        [hashtable]$Resolved
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        return [regex]::Replace($Value, '%([A-Za-z0-9_][A-Za-z0-9_.-]*)%', {
            param($match)
            $name = $match.Groups[1].Value
            if (-not $Resolved.ContainsKey($name)) {
                throw "transport_template.missing_variable: required variable '%$name%' was not supplied"
            }
            return [string]$Resolved[$name]
        })
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $out = @{}
        foreach ($key in $Value.Keys) {
            $out[$key] = Resolve-TransportTemplateNode -Value $Value[$key] -Resolved $Resolved
        }
        return $out
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @($Value | ForEach-Object { Resolve-TransportTemplateNode -Value $_ -Resolved $Resolved })
        return ,$items
    }
    if ($Value -is [pscustomobject]) {
        $out = @{}
        foreach ($prop in $Value.PSObject.Properties) {
            $out[$prop.Name] = Resolve-TransportTemplateNode -Value $prop.Value -Resolved $Resolved
        }
        return $out
    }
    return $Value
}

function Resolve-TransportTemplate {
    <#
    .SYNOPSIS
        Resolves a template's declared %name% variables into its payload.
    .DESCRIPTION
        Supplied values win over declared defaults; a declared variable with
        neither is required and throws before any target is touched. A %token%
        with no supplied value throws the same error.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [AllowNull()]
        [object]$Payload,

        [object[]]$DeclaredVariables = @(),

        [hashtable]$Variables = @{}
    )

    $resolved = @{}
    foreach ($declared in @($DeclaredVariables)) {
        if ($null -eq $declared) { continue }
        $name = [string]$declared.name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $supplied = if ($Variables.ContainsKey($name)) { [string]$Variables[$name] } else { '' }
        if (-not [string]::IsNullOrEmpty($supplied)) {
            $resolved[$name] = $supplied
            continue
        }
        $default = if ($null -ne $declared.defaultValue) { [string]$declared.defaultValue } else { '' }
        if (-not [string]::IsNullOrEmpty($default)) {
            $resolved[$name] = $default
            continue
        }
        throw "transport_template.missing_variable: required variable '%$name%' was not supplied"
    }
    foreach ($key in $Variables.Keys) {
        if (-not $resolved.ContainsKey($key) -and -not [string]::IsNullOrEmpty([string]$Variables[$key])) {
            $resolved[$key] = [string]$Variables[$key]
        }
    }

    return [pscustomobject]@{
        Payload   = Resolve-TransportTemplateNode -Value $Payload -Resolved $resolved
        Variables = $resolved
    }
}

function Read-DeployTransportTemplateJob {
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
    if (-not $json.kind) {
        throw "job envelope '$Path' is missing mandatory 'kind'"
    }
    if (-not $json.template) {
        throw "job envelope '$Path' is missing mandatory 'template'"
    }

    $vars = @{}
    if ($json.variables) {
        foreach ($prop in $json.variables.PSObject.Properties) {
            $vars[$prop.Name] = [string]$prop.Value
        }
    }

    return @{
        TenantId  = [string]$json.tenantId
        Kind      = [string]$json.kind
        Template  = $json.template
        Variables = $vars
        Actor     = if ($json.actor) { [string]$json.actor } else { 'system' }
        Confirmed = [bool]($json.confirmed -eq $true)
        DryRun    = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-TransportTemplateApply {
    <#
    .SYNOPSIS
        The EPIC-006 gated apply for one target: delegates to the per-kind worker.
    .DESCRIPTION
        Rule writes go through Invoke-SetTransportRule and connector writes
        through Invoke-SetConnector, so before/after capture and the AuditEvent
        come from the same gated path every other transport write uses.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('rule', 'connector')]
        [string]$Kind,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [hashtable]$Payload,

        [bool]$Confirmed = $true
    )

    if ($Kind -eq 'connector') {
        $params = @{
            TenantId  = $TenantId
            Action    = 'create'
            Name      = [string]$Payload['name']
            Type      = [string]$Payload['type']
            Confirmed = $Confirmed
            DryRun    = $false
        }
        if ($Payload.ContainsKey('senderDomains')) {
            $params['SenderDomains'] = (@($Payload['senderDomains']) -join ',')
        }
        if ($Payload.ContainsKey('recipientDomains')) {
            $params['RecipientDomains'] = (@($Payload['recipientDomains']) -join ',')
        }
        if ($Payload.ContainsKey('requireTls')) {
            $params['RequireTls'] = [bool]$Payload['requireTls']
        }
        if ($Payload.ContainsKey('secretRef') -and $Payload['secretRef']) {
            $params['SecretRef'] = [string]$Payload['secretRef']
        }
        return Invoke-SetConnector @params
    }

    $conditions = if ($Payload.ContainsKey('conditions') -and $Payload['conditions']) { $Payload['conditions'] } else { @{} }
    $actions = if ($Payload.ContainsKey('actions') -and $Payload['actions']) { $Payload['actions'] } else { @{} }
    $exceptions = if ($Payload.ContainsKey('exceptions') -and $Payload['exceptions']) { $Payload['exceptions'] } else { @{} }
    $ruleParams = @{
        TenantId       = $TenantId
        Action         = 'create'
        Name           = [string]$Payload['name']
        ConditionsJson = ($conditions | ConvertTo-Json -Depth 8 -Compress)
        ActionsJson    = ($actions | ConvertTo-Json -Depth 8 -Compress)
        ExceptionsJson = ($exceptions | ConvertTo-Json -Depth 8 -Compress)
        Confirmed      = $Confirmed
        DryRun         = $false
    }
    return Invoke-SetTransportRule @ruleParams
}

function Invoke-DeployTransportTemplate {
    <#
    .SYNOPSIS
        Plans (DryRun) or applies a transport template to one target tenant.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('rule', 'connector')]
        [string]$Kind,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TemplateJson,

        [hashtable]$Variables = @{},

        [string]$Actor = 'system',

        [bool]$DryRun = $false,

        [bool]$Confirmed = $false
    )

    $template = $TemplateJson | ConvertFrom-Json -AsHashtable
    $templateId = if ($template['id']) { [string]$template['id'] } else { [guid]::NewGuid().ToString() }
    $templateName = if ($template['name']) { [string]$template['name'] } else { 'Transport template' }
    $payloadField = if ($Kind -eq 'connector') { 'connectorJson' } else { 'ruleJson' }
    $payload = if ($template[$payloadField] -is [System.Collections.IDictionary]) { $template[$payloadField] } else { @{} }
    $declared = if ($template['variables']) { @($template['variables']) } else { @() }

    $resolved = Resolve-TransportTemplate -Payload $payload -DeclaredVariables $declared -Variables $Variables
    $resolvedPayload = $resolved.Payload
    $targetName = if ($resolvedPayload['name']) { [string]$resolvedPayload['name'] } else { $templateName }

    $label = if ($Kind -eq 'connector') { 'connector' } else { 'transport rule' }
    $diff = [System.Collections.Generic.List[string]]::new()
    $diff.Add("Deploy $label '$targetName' to tenant '$TenantId'")
    foreach ($key in ($resolved.Variables.Keys | Sort-Object)) {
        $diff.Add("Resolve %$key% = $($resolved.Variables[$key])")
    }

    $plan = [pscustomobject]@{
        tenantId   = $TenantId
        templateId = $templateId
        kind       = $Kind
        targetName = $targetName
        payload    = $resolvedPayload
        variables  = $resolved.Variables
        diff       = @($diff)
        valid      = $true
        dryRun     = $DryRun
    }

    if ($DryRun) {
        return [pscustomobject]@{ success = $true; plan = $plan; auditEvent = $null }
    }

    if (-not $Confirmed) {
        throw "transport.template_confirm_required: deploying a transport template requires explicit confirmation"
    }

    try {
        $outcome = Invoke-TransportTemplateApply -Kind $Kind -TenantId $TenantId -Payload $resolvedPayload -Confirmed $true
    }
    catch {
        return [pscustomobject]@{
            success    = $false
            state      = 'failed'
            plan       = $plan
            auditEvent = $null
            error      = $_.ToString()
        }
    }

    $auditEvent = $outcome.auditEvent
    if ($null -eq $auditEvent) {
        $auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "transport.template.deploy.$Kind"
            targetId   = $templateId
            targetName = $targetName
            actor      = $Actor
            timestamp  = (Get-Date).ToUniversalTime().ToString('o')
            before     = $null
            after      = $resolvedPayload
        }
    }

    return [pscustomobject]@{
        success    = $true
        state      = 'succeeded'
        tenantId   = $TenantId
        plan       = $plan
        result     = $outcome.result
        auditEvent = $auditEvent
        error      = $null
    }
}
