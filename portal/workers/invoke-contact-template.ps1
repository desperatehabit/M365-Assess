<#
.SYNOPSIS
    Worker entrypoint for the EPIC-023 contact template shape handler.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a template directly), validates the
    §5 ContactTemplate shape via Invoke-ContactTemplate, and emits the
    normalized template as JSON on stdout. Contact templates are global and
    carry no tenant writes, so this entrypoint opens no Graph or EXO session and
    handles no secrets. Invalid shapes are refused before any persistence.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TemplateId
    Direct template id for runs without a job envelope; empty on create.
.PARAMETER Name
    Direct template name.
.PARAMETER Properties
    Direct contact property map (a JSON object).
.PARAMETER Variables
    Direct deploy variable map (a JSON object). Omit when the template declares none.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-contact-template.ps1 -JobFile './run/contact-template-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-contact-template.ps1 -Name 'Vendor' -Properties @{ displayName = 'Vendor' }
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTemplate')]
    [ValidateNotNullOrEmpty()]
    [string]$Name,

    [Parameter(Mandatory, ParameterSetName = 'ByTemplate')]
    [object]$Properties,

    [Parameter(ParameterSetName = 'ByTemplate')]
    [string]$TemplateId = '',

    [Parameter(ParameterSetName = 'ByTemplate')]
    [object]$Variables = $null
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-ContactTemplate.ps1')

if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
    $job = Read-ContactTemplateJob -Path $JobFile
    $TemplateId = $job['TemplateId']
    $Name = $job['Name']
    $Properties = $job['Properties']
    $Variables = $job['Variables']
}

$result = Invoke-ContactTemplate -TemplateId $TemplateId -Name $Name -Properties $Properties -Variables $Variables
$result | ConvertTo-Json -Depth 10 -Compress
