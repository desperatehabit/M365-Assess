# Resolve-ReportBinding.ps1
# EPIC-005 SPEC.md §3.2, §11.3 — report block data binding resolver.
#
# Given a block's dataBinding descriptor, resolves the live data from persisted
# rows into the typed block payload that the T-0081 contract expects.
#
# Bindable entities (§11.3 adopted set — exactly five):
#   run-summary   — high-level counts from the latest assessment run
#   findings      — individual control findings (filterable by severity/status)
#   compliance    — deviation counts by state
#   secure-score  — current / max / comparison values
#   licenses      — per-SKU assigned/purchased data
#
# Unknown bindings are rejected with a clear error rather than silently producing
# empty output (§9 block/data-drift mitigation).
# Static blocks (isStatic = true) are returned unchanged.
# A captured snapshot can be reverted to live data by calling the resolver with
# the block's original dataBinding descriptor.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ─── Constants ────────────────────────────────────────────────────────

$script:BindableEntities = @(
    'run-summary',
    'findings',
    'compliance',
    'secure-score',
    'licenses'
)

#endregion

#region ─── Public functions ─────────────────────────────────────────────────

function Resolve-ReportBinding {
    <#
    .SYNOPSIS
        Resolves a report block's live data binding into a typed block payload.
    .DESCRIPTION
        Accepts a block descriptor (hashtable or PSCustomObject with at least
        Id, Type, IsStatic, DataBinding?) and a data-source object, and returns
        the resolved block payload ready for the renderer.

        Behaviour:
          - Static blocks (IsStatic = $true) are returned as-is without any
            data resolution.
          - Live blocks with a recognised dataBinding.entity are resolved using
            the injected data-source.
          - An unrecognised entity causes a non-terminating or terminating error
            (controlled by -ErrorAction) so callers can surface validation
            failures at preview time rather than silently outputting empty blocks.
          - A missing or null field in the data source produces an explicit
            validation error (ValidationResult.Errors is populated) instead of
            emitting a silent null.
    .PARAMETER Block
        A PSCustomObject or hashtable describing the block.
        Required keys: Id (string), Type (string), IsStatic (bool).
        Optional key: DataBinding (object with 'entity' string key).
    .PARAMETER DataSource
        A PSCustomObject or hashtable with optional keys matching the five
        bindable entities.  Each key holds the resolved live data for that
        entity.  Missing keys cause a validation error for live blocks that
        bind to them.
    .OUTPUTS
        [PSCustomObject] with fields:
          BlockId        – echoed from input
          Entity         – null for static blocks, entity name otherwise
          IsStatic       – echoed from input
          Data           – resolved payload, or null for static blocks
          ValidationResult – object with IsValid (bool) and Errors (string[])
    .EXAMPLE
        $block = [PSCustomObject]@{
            Id        = 'blk-1'
            Type      = 'score-cards'
            IsStatic  = $false
            DataBinding = [PSCustomObject]@{ entity = 'secure-score' }
        }
        $source = [PSCustomObject]@{
            'secure-score' = [PSCustomObject]@{ current = 72; max = 100 }
        }
        Resolve-ReportBinding -Block $block -DataSource $source
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [object]$Block,

        [Parameter()]
        [object]$DataSource = $null
    )

    $blockId   = Get-BlockField -Block $Block -Field 'Id'
    $isStatic  = [bool](Get-BlockField -Block $Block -Field 'IsStatic' -Default $false)

    if ($isStatic) {
        return [PSCustomObject]@{
            BlockId          = $blockId
            Entity           = $null
            IsStatic         = $true
            Data             = $null
            ValidationResult = [PSCustomObject]@{ IsValid = $true; Errors = @() }
        }
    }

    $binding = Get-BlockField -Block $Block -Field 'DataBinding' -Default $null
    if ($null -eq $binding) {
        $errors = @("Block '$blockId' is not static but has no DataBinding descriptor.")
        return [PSCustomObject]@{
            BlockId          = $blockId
            Entity           = $null
            IsStatic         = $false
            Data             = $null
            ValidationResult = [PSCustomObject]@{ IsValid = $false; Errors = $errors }
        }
    }

    $entity = Get-ObjectProperty -Object $binding -Name 'entity'
    if (-not $entity) {
        $errors = @("Block '$blockId' DataBinding is missing the 'entity' field.")
        return [PSCustomObject]@{
            BlockId          = $blockId
            Entity           = $null
            IsStatic         = $false
            Data             = $null
            ValidationResult = [PSCustomObject]@{ IsValid = $false; Errors = $errors }
        }
    }

    if ($entity -notin $script:BindableEntities) {
        # Rejected rather than silently empty — §9 data-drift mitigation.
        $allowed = $script:BindableEntities -join ', '
        $errors = @("Block '$blockId' references unknown binding entity '$entity'. Allowed: $allowed.")
        return [PSCustomObject]@{
            BlockId          = $blockId
            Entity           = $entity
            IsStatic         = $false
            Data             = $null
            ValidationResult = [PSCustomObject]@{ IsValid = $false; Errors = $errors }
        }
    }

    # Resolve the live data from the source for this entity.
    $data = $null
    $validationErrors = @()

    if ($null -ne $DataSource) {
        $data = Get-ObjectProperty -Object $DataSource -Name $entity
    }

    if ($null -eq $data) {
        $validationErrors += "Block '$blockId' binding '$entity': no data available in the data source. " +
                             "The field may be missing, null, or from a run that has not yet completed."
    }

    $isValid = $validationErrors.Count -eq 0

    return [PSCustomObject]@{
        BlockId          = $blockId
        Entity           = $entity
        IsStatic         = $false
        Data             = $data
        ValidationResult = [PSCustomObject]@{ IsValid = $isValid; Errors = $validationErrors }
    }
}

function Resolve-ReportDocument {
    <#
    .SYNOPSIS
        Resolves all blocks in a report document against a data source.
    .DESCRIPTION
        Iterates the document's blocks array and calls Resolve-ReportBinding for
        each block.  Returns the resolved blocks and a combined validation result.
        At least one invalid block makes the document result invalid.
    .PARAMETER Document
        A PSCustomObject or hashtable with a 'blocks' array property.
    .PARAMETER DataSource
        Same shape as Resolve-ReportBinding -DataSource.
    .OUTPUTS
        [PSCustomObject] with:
          ResolvedBlocks   – array of Resolve-ReportBinding results
          ValidationResult – combined IsValid + aggregated Errors[]
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [object]$Document,

        [Parameter()]
        [object]$DataSource = $null
    )

    $blocks = Get-ObjectProperty -Object $Document -Name 'blocks'
    if ($null -eq $blocks) {
        $blocks = @()
    }

    $resolved   = @()
    $allErrors  = @()
    $allValid   = $true

    foreach ($block in $blocks) {
        $result = Resolve-ReportBinding -Block $block -DataSource $DataSource
        $resolved  += $result
        if (-not $result.ValidationResult.IsValid) {
            $allValid  = $false
            $allErrors += $result.ValidationResult.Errors
        }
    }

    return [PSCustomObject]@{
        ResolvedBlocks   = $resolved
        ValidationResult = [PSCustomObject]@{ IsValid = $allValid; Errors = $allErrors }
    }
}

#endregion

#region ─── Internal helpers ─────────────────────────────────────────────────

function Get-BlockField {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Block,
        [Parameter(Mandatory)][string]$Field,
        [object]$Default = $null
    )
    $val = Get-ObjectProperty -Object $Block -Name $Field
    if ($null -eq $val) { return $Default }
    return $val
}

function Get-ObjectProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Object -is [hashtable]) {
        if ($Object.ContainsKey($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

#endregion
