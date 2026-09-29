# Get-IncidentDetail.ps1 — EPIC-028 incident detail (SPEC §2 US-2, §3.2, §5, §6; T-0545).
#
# Live Graph reads only: one security incident with its linked alerts (shaped to
# the T-0542 normalized alert model), entities derived from alert evidence, and
# a timeline of live events. Portal notes and triage state changes (persisted by
# T-0541) arrive as parameters from the BFF — which owns the database — and are
# merged into the notes and timeline here. An unknown incident returns the
# { error, message, statusCode } shape the BFF maps to a structured 404 instead
# of throwing, so the route can distinguish "no such incident" from a worker
# failure.

function Get-IncidentDetailProperty {
    <#
    .SYNOPSIS
        Reads a property from Graph responses and Pester mocks alike.
    .DESCRIPTION
        Live Invoke-MgGraphRequest results are PSObjects while Pester mocks
        return hashtables; this reads both without throwing under strict mode.
    .PARAMETER Object
        The response object to read from.
    .PARAMETER Name
        The property name.
    .EXAMPLE
        Get-IncidentDetailProperty -Object $incident -Name 'displayName'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    if ($null -eq $Object) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) {
        return $property.Value
    }
    return $null
}

function ConvertTo-NormalizedAlertSeverity {
    <#
    .SYNOPSIS
        Maps a Graph alert severity onto the T-0542 normalized vocabulary.
    .PARAMETER Value
        The raw severity string.
    .EXAMPLE
        ConvertTo-NormalizedAlertSeverity -Value 'High'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()][string]$Value = ''
    )
    switch ($Value.Trim().ToLowerInvariant()) {
        'informational' { return 'informational' }
        'low' { return 'low' }
        'medium' { return 'medium' }
        'high' { return 'high' }
        default { return 'unknown' }
    }
}

function ConvertTo-NormalizedAlertStatus {
    <#
    .SYNOPSIS
        Maps a Graph alert status onto the T-0542 normalized vocabulary.
    .PARAMETER Value
        The raw status string.
    .EXAMPLE
        ConvertTo-NormalizedAlertStatus -Value 'InProgress'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()][string]$Value = ''
    )
    switch ($Value.Trim().ToLowerInvariant()) {
        'new' { return 'new' }
        'inprogress' { return 'inProgress' }
        'resolved' { return 'resolved' }
        default { return 'unknown' }
    }
}

function ConvertTo-NormalizedAlertSource {
    <#
    .SYNOPSIS
        Maps a Graph alert service source onto the T-0542 source vocabulary.
    .DESCRIPTION
        Defender for Office 365 alerts share the Defender pipeline, so a
        service source naming Office 365, MDO, or Exchange Online maps to mdo;
        other Defender sources map to defender and anything else to graph.
    .PARAMETER Value
        The raw serviceSource string.
    .EXAMPLE
        ConvertTo-NormalizedAlertSource -Value 'Microsoft Defender for Office 365'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()][string]$Value = ''
    )
    $source = $Value.Trim().ToLowerInvariant()
    if ($source -match 'office 365|\bmdo\b|exchange online') {
        return 'mdo'
    }
    if ($source -match 'defender') {
        return 'defender'
    }
    return 'graph'
}

function Get-NormalizedAlertEntity {
    <#
    .SYNOPSIS
        Picks the primary entity from a Graph alert's evidence.
    .DESCRIPTION
        Returns the first evidence entry with a mappable user, device,
        mailbox, ip, file, url, or process type; falls back to the actor
        display name as an unknown-kind entity and to null when neither
        exists, matching the T-0542 contract.
    .PARAMETER Alert
        The raw Graph alert object.
    .EXAMPLE
        Get-NormalizedAlertEntity -Alert $alert
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()][object]$Alert
    )
    foreach ($item in @((Get-IncidentDetailProperty -Object $Alert -Name 'evidence'))) {
        if ($null -eq $item) {
            continue
        }
        $type = [string](Get-IncidentDetailProperty -Object $item -Name '@odata.type')
        if ([string]::IsNullOrEmpty($type)) {
            $type = [string](Get-IncidentDetailProperty -Object $item -Name 'evidenceType')
        }
        $lower = $type.ToLowerInvariant()
        $kind = $null
        if ($lower -match 'user') { $kind = 'user' }
        elseif ($lower -match 'device') { $kind = 'device' }
        elseif ($lower -match 'mailbox') { $kind = 'mailbox' }
        elseif ($lower -match 'process') { $kind = 'process' }
        elseif ($lower -match 'url') { $kind = 'url' }
        elseif ($lower -match 'file') { $kind = 'file' }
        elseif ($lower -match '\bip\b') { $kind = 'ip' }
        if ($null -eq $kind) {
            continue
        }
        $entity = [pscustomobject]@{ kind = $kind }
        $name = Get-IncidentDetailProperty -Object $item -Name 'displayName'
        if ($null -eq $name) {
            $name = Get-IncidentDetailProperty -Object $item -Name 'deviceDnsName'
        }
        if ($null -eq $name) {
            $name = Get-IncidentDetailProperty -Object $item -Name 'primaryAddress'
        }
        if ($null -eq $name) {
            $name = Get-IncidentDetailProperty -Object $item -Name 'ipAddress'
        }
        if ($null -ne $name -and [string]$name -ne '') {
            $entity | Add-Member -NotePropertyName 'displayName' -NotePropertyValue ([string]$name)
        }
        $id = Get-IncidentDetailProperty -Object $item -Name 'mdeDeviceId'
        if ($null -eq $id) {
            $id = Get-IncidentDetailProperty -Object $item -Name 'azureAdUserId'
        }
        if ($null -eq $id) {
            $id = Get-IncidentDetailProperty -Object $item -Name 'accountName'
        }
        if ($null -ne $id -and [string]$id -ne '') {
            $entity | Add-Member -NotePropertyName 'id' -NotePropertyValue ([string]$id)
        }
        return $entity
    }
    $actor = Get-IncidentDetailProperty -Object $Alert -Name 'actorDisplayName'
    if ($null -ne $actor -and [string]$actor -ne '') {
        return [pscustomobject]@{
            kind        = 'unknown'
            displayName = [string]$actor
        }
    }
    return $null
}

function ConvertTo-NormalizedIncidentAlert {
    <#
    .SYNOPSIS
        Shapes one raw Graph alert into the T-0542 normalized alert model.
    .PARAMETER Alert
        The raw Graph alert object.
    .PARAMETER IncidentId
        The incident the alert is linked to.
    .EXAMPLE
        ConvertTo-NormalizedIncidentAlert -Alert $alert -IncidentId 'incident-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()][object]$Alert,
        [Parameter(Mandatory)][string]$IncidentId
    )
    $passthrough = @{}
    if ($Alert -is [System.Collections.IDictionary]) {
        foreach ($key in @($Alert.Keys)) {
            if ($key -notin @('id', 'title', 'severity', 'status', 'createdDateTime', 'incidentId', 'actorDisplayName', 'evidence', '@odata.type', 'serviceSource')) {
                $passthrough[[string]$key] = $Alert[$key]
            }
        }
    }
    else {
        foreach ($property in @($Alert.PSObject.Properties)) {
            if ($property.Name -notin @('id', 'title', 'severity', 'status', 'createdDateTime', 'incidentId', 'actorDisplayName', 'evidence', '@odata.type', 'serviceSource')) {
                $passthrough[$property.Name] = $property.Value
            }
        }
    }
    return [pscustomobject]@{
        schemaVersion = 'v1'
        id            = [string](Get-IncidentDetailProperty -Object $Alert -Name 'id')
        source        = ConvertTo-NormalizedAlertSource -Value ([string](Get-IncidentDetailProperty -Object $Alert -Name 'serviceSource'))
        title         = [string](Get-IncidentDetailProperty -Object $Alert -Name 'title')
        severity      = ConvertTo-NormalizedAlertSeverity -Value ([string](Get-IncidentDetailProperty -Object $Alert -Name 'severity'))
        status        = ConvertTo-NormalizedAlertStatus -Value ([string](Get-IncidentDetailProperty -Object $Alert -Name 'status'))
        entity        = Get-NormalizedAlertEntity -Alert $Alert
        created       = [string](Get-IncidentDetailProperty -Object $Alert -Name 'createdDateTime')
        incidentId    = $IncidentId
        passthrough   = $passthrough
    }
}

function Get-IncidentDetail {
    <#
    .SYNOPSIS
        Reads one security incident with alerts, entities, and timeline.
    .DESCRIPTION
        Reads the incident and its linked alerts live from Graph, normalizes
        the alerts to the T-0542 model, derives the involved entities from
        alert evidence, and builds the timeline from live events plus the
        persisted portal notes and triage state changes passed in. Only GET
        requests are issued.
    .PARAMETER TenantId
        Tenant the incident belongs to. Carried through to the result envelope.
    .PARAMETER IncidentId
        The Graph security incident id.
    .PARAMETER PortalNotes
        Persisted T-0541 incident notes (id, body, author, at) merged into
        notes and the timeline.
    .PARAMETER StateChanges
        Persisted T-0541 triage state changes (id, alertId, incidentId, from,
        to, by, at, reason) merged into the timeline.
    .EXAMPLE
        Get-IncidentDetail -TenantId 'tenant-a' -IncidentId 'incident-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$IncidentId,

        [Parameter()]
        [object[]]$PortalNotes = @(),

        [Parameter()]
        [object[]]$StateChanges = @()
    )

    $incident = $null
    try {
        $incident = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/security/incidents/$IncidentId"
    }
    catch {
        if ("$($_.Exception.Message)" -match '(?i)404|not.?found') {
            return [pscustomobject]@{
                error      = 'incident.not_found'
                message    = "Incident '$IncidentId' not found in tenant '$TenantId'."
                statusCode = 404
            }
        }
        throw
    }
    if ($null -eq $incident -or [string](Get-IncidentDetailProperty -Object $incident -Name 'id') -eq '') {
        return [pscustomobject]@{
            error      = 'incident.not_found'
            message    = "Incident '$IncidentId' not found in tenant '$TenantId'."
            statusCode = 404
        }
    }

    $alertsUri = "/v1.0/security/alerts_v2?`$filter=incidentId eq '$IncidentId'&`$top=100"
    $alertsResponse = Invoke-MgGraphRequest -Method GET -Uri $alertsUri

    $alerts = [System.Collections.Generic.List[object]]::new()
    foreach ($alert in @((Get-IncidentDetailProperty -Object $alertsResponse -Name 'value'))) {
        if ($null -eq $alert) {
            continue
        }
        $alerts.Add((ConvertTo-NormalizedIncidentAlert -Alert $alert -IncidentId $IncidentId))
    }

    $entities = [System.Collections.Generic.List[object]]::new()
    $seenEntities = @{}
    foreach ($alert in @($alerts)) {
        if ($null -eq $alert.entity) {
            continue
        }
        $key = "$($alert.entity.kind)|$($alert.entity.id)|$($alert.entity.displayName)"
        if ($seenEntities.ContainsKey($key)) {
            $existing = $seenEntities[$key]
            if ($existing.alertIds -notcontains $alert.id) {
                $existing.alertIds += @($alert.id)
            }
            continue
        }
        $entity = [pscustomobject]@{
            kind        = [string]$alert.entity.kind
            alertIds    = @($alert.id)
        }
        if ($null -ne $alert.entity.id) {
            $entity | Add-Member -NotePropertyName 'id' -NotePropertyValue ([string]$alert.entity.id)
        }
        if ($null -ne $alert.entity.displayName) {
            $entity | Add-Member -NotePropertyName 'displayName' -NotePropertyValue ([string]$alert.entity.displayName)
        }
        $seenEntities[$key] = $entity
        $entities.Add($entity)
    }

    $timeline = [System.Collections.Generic.List[object]]::new()
    $created = [string](Get-IncidentDetailProperty -Object $incident -Name 'createdDateTime')
    if ($created -ne '') {
        $timeline.Add([pscustomobject]@{
            at      = $created
            type    = 'incident.created'
            summary = "Incident opened with severity '$((Get-IncidentDetailProperty -Object $incident -Name 'severity'))'."
        })
    }
    $updated = [string](Get-IncidentDetailProperty -Object $incident -Name 'lastUpdateDateTime')
    if ($updated -ne '' -and $updated -ne $created) {
        $timeline.Add([pscustomobject]@{
            at      = $updated
            type    = 'incident.updated'
            summary = "Incident last updated with status '$((Get-IncidentDetailProperty -Object $incident -Name 'status'))'."
        })
    }
    foreach ($alert in @($alerts)) {
        $timeline.Add([pscustomobject]@{
            at      = $alert.created
            type    = 'alert.created'
            summary = "Alert '$($alert.title)' linked with severity '$($alert.severity)'."
            ref     = $alert.id
        })
    }

    $linkedAlertIds = @($alerts | ForEach-Object { $_.id })
    foreach ($change in @($StateChanges)) {
        if ($null -eq $change) {
            continue
        }
        $changeIncident = [string](Get-IncidentDetailProperty -Object $change -Name 'incidentId')
        $changeAlert = [string](Get-IncidentDetailProperty -Object $change -Name 'alertId')
        if ($changeIncident -ne '' -and $changeIncident -ne $IncidentId -and $linkedAlertIds -notcontains $changeAlert) {
            continue
        }
        $timeline.Add([pscustomobject]@{
            at      = [string](Get-IncidentDetailProperty -Object $change -Name 'at')
            type    = 'triage.state_change'
            summary = "State changed from '$((Get-IncidentDetailProperty -Object $change -Name 'from'))' to '$((Get-IncidentDetailProperty -Object $change -Name 'to'))'."
            actor   = [string](Get-IncidentDetailProperty -Object $change -Name 'by')
            ref     = [string](Get-IncidentDetailProperty -Object $change -Name 'id')
        })
    }

    $notes = [System.Collections.Generic.List[object]]::new()
    foreach ($note in @($PortalNotes)) {
        if ($null -eq $note) {
            continue
        }
        $noteIncident = [string](Get-IncidentDetailProperty -Object $note -Name 'incidentId')
        if ($noteIncident -ne '' -and $noteIncident -ne $IncidentId) {
            continue
        }
        $notes.Add([pscustomobject]@{
            id     = [string](Get-IncidentDetailProperty -Object $note -Name 'id')
            body   = [string](Get-IncidentDetailProperty -Object $note -Name 'body')
            author = [string](Get-IncidentDetailProperty -Object $note -Name 'author')
            at     = [string](Get-IncidentDetailProperty -Object $note -Name 'at')
        })
        $timeline.Add([pscustomobject]@{
            at      = [string](Get-IncidentDetailProperty -Object $note -Name 'at')
            type    = 'note.added'
            summary = 'Portal comment added.'
            actor   = [string](Get-IncidentDetailProperty -Object $note -Name 'author')
            ref     = [string](Get-IncidentDetailProperty -Object $note -Name 'id')
        })
    }

    $orderedTimeline = @($timeline | Sort-Object -Property at)

    return [pscustomobject]@{
        tenantId    = $TenantId
        incidentId  = $IncidentId
        overview    = [pscustomobject]@{
            incidentId     = [string](Get-IncidentDetailProperty -Object $incident -Name 'id')
            title          = [string](Get-IncidentDetailProperty -Object $incident -Name 'displayName')
            severity       = [string](Get-IncidentDetailProperty -Object $incident -Name 'severity')
            status         = [string](Get-IncidentDetailProperty -Object $incident -Name 'status')
            classification = [string](Get-IncidentDetailProperty -Object $incident -Name 'classification')
            assignee       = [string](Get-IncidentDetailProperty -Object $incident -Name 'assignedTo')
            created        = $created
            lastUpdated    = [string](Get-IncidentDetailProperty -Object $incident -Name 'lastUpdateDateTime')
            webUrl         = [string](Get-IncidentDetailProperty -Object $incident -Name 'incidentWebUrl')
        }
        alerts      = @($alerts)
        entities    = @($entities)
        timeline    = @($orderedTimeline)
        notes       = @($notes)
        retrievedAt = (Get-Date -Format 'o')
    }
}
