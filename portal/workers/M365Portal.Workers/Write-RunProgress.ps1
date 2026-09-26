<#
.SYNOPSIS
    Worker-side progress emission adhering to T-0014 progress event contract (EPIC-003 SPEC.md §4.2, §11.3, T-0045).
.DESCRIPTION
    Maps per-section and per-check assessment progress from the module's progress signals
    (Update-CheckProgress, Update-ProgressStatus) to versioned T-0014 progress event envelopes.
    Emits RunSection events per section with an advancing aggregate check counter by default,
    and supports opt-in check-level detail emission.
#>

$script:WorkerProgressSequence = 0
$script:RunProgressState = $null

function Get-RunProgressSection {
    <#
    .SYNOPSIS
        Resolves the assessment section name from a check ID or collector name.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$CheckId = '',

        [Parameter()]
        [string]$Collector = ''
    )

    $collectorMap = @{
        'Entra'            = 'Identity'
        'CAEvaluator'      = 'Identity'
        'ExchangeOnline'   = 'Email'
        'DNS'              = 'Email'
        'Defender'         = 'Security'
        'Compliance'       = 'Security'
        'StrykerReadiness' = 'Security'
        'CriticalExposure' = 'Security'
        'Intune'           = 'Intune'
        'SharePoint'       = 'Collaboration'
        'Teams'            = 'Collaboration'
        'PowerBI'          = 'PowerBI'
    }

    if ($Collector -and $collectorMap.ContainsKey($Collector)) {
        return $collectorMap[$Collector]
    }

    if ($CheckId) {
        $prefix = ($CheckId -split '[-_.]')[0]
        switch ($prefix.ToUpperInvariant()) {
            'ENTRA'      { return 'Identity' }
            'CA'         { return 'Identity' }
            'EXO'        { return 'Email' }
            'DNS'        { return 'Email' }
            'DEFENDER'   { return 'Security' }
            'COMPLIANCE' { return 'Security' }
            'PURVIEW'    { return 'Security' }
            'STRYKER'    { return 'Security' }
            'INTUNE'     { return 'Intune' }
            'SPO'        { return 'Collaboration' }
            'OD'         { return 'Collaboration' }
            'TEAMS'      { return 'Collaboration' }
            'POWERBI'    { return 'PowerBI' }
            default      { return 'Security' }
        }
    }

    return 'Security'
}

function Reset-RunProgressSequence {
    [CmdletBinding()]
    param()
    $script:WorkerProgressSequence = 0
}

function Write-RunProgress {
    <#
    .SYNOPSIS
        Emits a structured progress event conforming to the T-0014 progress event contract.
    .DESCRIPTION
        Constructs a versioned progress event (schemaVersion: 'v1'), assigns a monotonic sequence,
        serializes it as a single line JSON string, and writes it to the progress channel (stdout).
        Check-level events are emitted only when -EmitCheckDetail is set.
    #>
    [CmdletBinding(DefaultParameterSetName = 'Progress')]
    param(
        [Parameter(ParameterSetName = 'Reset', Mandatory = $true)]
        [switch]$ResetSequence,

        [Parameter(ParameterSetName = 'Progress', Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$RunId,

        [Parameter(ParameterSetName = 'Progress', Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(ParameterSetName = 'Progress', Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(ParameterSetName = 'Progress')]
        [string]$RequestId = '',

        [Parameter(ParameterSetName = 'Progress')]
        [string]$CorrelationId = '',

        [Parameter(ParameterSetName = 'Progress')]
        [ValidateSet('assessment', 'standards', 'drift', 'baseline', 'backup', 'remediation', 'custom-script', 'report')]
        [string]$JobType = 'assessment',

        [Parameter(ParameterSetName = 'Progress')]
        [ValidateSet('queued', 'running', 'succeeded', 'failed', 'cancelled')]
        [string]$State = 'running',

        [Parameter(ParameterSetName = 'Progress')]
        [string]$Section = '',

        [Parameter(ParameterSetName = 'Progress')]
        [ValidateSet('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')]
        [string]$SectionState = '',

        [Parameter(ParameterSetName = 'Progress')]
        [Nullable[int]]$Completed = $null,

        [Parameter(ParameterSetName = 'Progress')]
        [Nullable[int]]$Total = $null,

        [Parameter(ParameterSetName = 'Progress')]
        [string]$Message = '',

        [Parameter(ParameterSetName = 'Progress')]
        [string]$CheckId = '',

        [Parameter(ParameterSetName = 'Progress')]
        [string]$Setting = '',

        [Parameter(ParameterSetName = 'Progress')]
        [string]$CheckStatus = '',

        [Parameter(ParameterSetName = 'Progress')]
        [switch]$EmitCheckDetail,

        [Parameter(ParameterSetName = 'Progress')]
        [Nullable[int]]$Sequence = $null,

        [Parameter(ParameterSetName = 'Progress')]
        [string]$At = '',

        [Parameter(ParameterSetName = 'Progress')]
        [scriptblock]$Channel = $null,

        [Parameter(ParameterSetName = 'Progress')]
        [switch]$PassThru
    )

    if ($ResetSequence) {
        $script:WorkerProgressSequence = 0
        return
    }

    # Check-level events are opt-in: skip emission if check info passed without -EmitCheckDetail
    if ($CheckId -and (-not $EmitCheckDetail)) {
        if ($PassThru) { return $null }
        return
    }

    if ($CheckId -and $EmitCheckDetail) {
        if (-not $Section) {
            $Section = Get-RunProgressSection -CheckId $CheckId
        }
        if (-not $SectionState) {
            $SectionState = 'running'
        }
        if (-not $Message) {
            $Message = if ($Setting) { "$($CheckId): $Setting ($CheckStatus)" } else { "$CheckId ($CheckStatus)" }
        }
    }

    $seq = if ($null -ne $Sequence) {
        [int]$Sequence
    } else {
        if ($null -eq $script:WorkerProgressSequence) {
            $script:WorkerProgressSequence = 0
        }
        $currentSeq = $script:WorkerProgressSequence
        $script:WorkerProgressSequence++
        $currentSeq
    }

    if (-not $RequestId) { $RequestId = $JobId }
    if (-not $CorrelationId) { $CorrelationId = $JobId }
    if (-not $At) {
        $At = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    }

    $envelope = [ordered]@{
        schemaVersion = 'v1'
        sequence      = [int]$seq
        eventId       = [guid]::NewGuid().ToString()
        runId         = $RunId
        tenantId      = $TenantId
        jobId         = $JobId
        jobType       = $JobType
        requestId     = $RequestId
        correlationId = $CorrelationId
        at            = $At
        state         = $State
    }

    if ($Section) {
        $envelope['section'] = $Section
    }
    if ($SectionState) {
        $envelope['sectionState'] = $SectionState
    }
    if ($null -ne $Completed) {
        $envelope['completed'] = [int]$Completed
    }
    if ($null -ne $Total) {
        $envelope['total'] = [int]$Total
    }
    if ($Message) {
        $envelope['message'] = $Message
    }

    $json = $envelope | ConvertTo-Json -Compress -Depth 5

    # Write to designated channel or process stdout
    if ($Channel) {
        & $Channel $json
    }
    elseif ($script:RunProgressState -and $script:RunProgressState.Channel) {
        & $script:RunProgressState.Channel $json
    }
    else {
        [System.Console]::Out.WriteLine($json)
    }

    if ($PassThru) {
        return [PSCustomObject]$envelope
    }
}

function Register-RunProgressBridge {
    <#
    .SYNOPSIS
        Hooks the assessment module's progress output to emit structured T-0014 progress events.
    .DESCRIPTION
        Registers global Update-CheckProgress and Update-ProgressStatus implementations
        that map the module's check and collector execution into RunSection events,
        advances the check counter, and emits events to the job's progress channel.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RunId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter()]
        [string]$RequestId = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$JobType = 'assessment',

        [Parameter()]
        [int]$TotalChecks = 0,

        [Parameter()]
        [string[]]$Sections = @(),

        [Parameter()]
        [switch]$EmitCheckDetail,

        [Parameter()]
        [scriptblock]$Channel = $null
    )

    $script:WorkerProgressSequence = 0

    $script:RunProgressState = [ordered]@{
        RunId           = $RunId
        TenantId        = $TenantId
        JobId           = $JobId
        RequestId       = if ($RequestId) { $RequestId } else { $JobId }
        CorrelationId   = if ($CorrelationId) { $CorrelationId } else { $JobId }
        JobType         = $JobType
        Total           = $TotalChecks
        Completed       = 0
        CurrentSection  = $null
        SectionsSeen    = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        EmitCheckDetail = [bool]$EmitCheckDetail
        Channel         = $Channel
    }

    function global:Update-CheckProgress {
        [CmdletBinding()]
        param(
            [string]$CheckId,
            [string]$Setting,
            [string]$Status
        )

        if (-not $script:RunProgressState) { return }
        $state = $script:RunProgressState
        $state.Completed++

        $section = Get-RunProgressSection -CheckId $CheckId

        # If section changed, close previous section and start new section
        if ($section -and ($section -ne $state.CurrentSection)) {
            if ($state.CurrentSection) {
                Write-RunProgress -RunId $state.RunId -TenantId $state.TenantId -JobId $state.JobId `
                    -RequestId $state.RequestId -CorrelationId $state.CorrelationId -JobType $state.JobType `
                    -State 'running' -Section $state.CurrentSection -SectionState 'succeeded' `
                    -Completed $state.Completed -Total $state.Total -Channel $state.Channel | Out-Null
            }
            $state.CurrentSection = $section
            $state.SectionsSeen.Add($section) | Out-Null

            Write-RunProgress -RunId $state.RunId -TenantId $state.TenantId -JobId $state.JobId `
                -RequestId $state.RequestId -CorrelationId $state.CorrelationId -JobType $state.JobType `
                -State 'running' -Section $section -SectionState 'running' `
                -Completed $state.Completed -Total $state.Total -Channel $state.Channel | Out-Null
        }

        # Check-level event emitted only when opt-in flag is enabled
        if ($state.EmitCheckDetail) {
            $msg = if ($Setting) { "$($CheckId): $Setting ($Status)" } else { "$CheckId ($Status)" }
            Write-RunProgress -RunId $state.RunId -TenantId $state.TenantId -JobId $state.JobId `
                -RequestId $state.RequestId -CorrelationId $state.CorrelationId -JobType $state.JobType `
                -State 'running' -Section $section -SectionState 'running' `
                -Completed $state.Completed -Total $state.Total -Message $msg -EmitCheckDetail `
                -Channel $state.Channel | Out-Null
        }
    }

    function global:Update-ProgressStatus {
        [CmdletBinding()]
        param([string]$Message)
        # Allows module's status messages without error
    }
}

function Step-RunSectionProgress {
    <#
    .SYNOPSIS
        Explicitly emits a RunSection state change.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RunId,

        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string]$JobId,

        [Parameter(Mandatory)]
        [string]$Section,

        [Parameter(Mandatory)]
        [ValidateSet('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')]
        [string]$SectionState,

        [Parameter()]
        [Nullable[int]]$Completed = $null,

        [Parameter()]
        [Nullable[int]]$Total = $null,

        [Parameter()]
        [string]$Message = '',

        [Parameter()]
        [scriptblock]$Channel = $null,

        [Parameter()]
        [switch]$PassThru
    )

    return Write-RunProgress -RunId $RunId -TenantId $TenantId -JobId $JobId `
        -Section $Section -SectionState $SectionState `
        -Completed $Completed -Total $Total -Message $Message `
        -Channel $Channel -PassThru:$PassThru
}

function Complete-RunProgressBridge {
    <#
    .SYNOPSIS
        Closes any active section in the bridge and unregisters global hooks.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [ValidateSet('succeeded', 'failed', 'cancelled')]
        [string]$Status = 'succeeded'
    )

    if (-not $script:RunProgressState) { return }
    $state = $script:RunProgressState

    # If an active section remains open, mark it finished
    if ($state.CurrentSection) {
        $secState = if ($Status -eq 'succeeded') { 'succeeded' } else { 'failed' }
        Write-RunProgress -RunId $state.RunId -TenantId $state.TenantId -JobId $state.JobId `
            -RequestId $state.RequestId -CorrelationId $state.CorrelationId -JobType $state.JobType `
            -State 'running' -Section $state.CurrentSection -SectionState $secState `
            -Completed $state.Completed -Total $state.Total -Channel $state.Channel | Out-Null
        $state.CurrentSection = $null
    }

    Remove-Item -Path 'Function:\Update-CheckProgress'  -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Update-ProgressStatus' -ErrorAction SilentlyContinue
    $script:RunProgressState = $null
}
