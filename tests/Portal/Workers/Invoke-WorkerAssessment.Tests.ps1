BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:workerManifest = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/M365Portal.Workers.psd1'
    $script:stubTenantId = '00000000-0000-0000-0000-000000000001'

    Import-Module -Name $script:workerManifest -Force

    $script:scratchRoots = @()

    function script:New-WorkerScratch {
        $root = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("m365-worker-options-{0}" -f [guid]::NewGuid().ToString('N'))
        New-Item -Path $root -ItemType Directory -Force | Out-Null
        $script:scratchRoots += $root
        return $root
    }

    function script:New-OptionContextFile {
        param(
            [Parameter(Mandatory)]
            [string]$Directory,

            [Parameter(Mandatory)]
            [hashtable]$Options
        )

        $contextFile = Join-Path -Path $Directory -ChildPath 'context.json'
        [ordered]@{
            SchemaVersion = 1
            Tenant        = @{
                TenantId      = $script:stubTenantId
                DefaultDomain = 'contoso.example'
            }
            Auth          = @{
                Method         = 'Certificate'
                ClientId       = 'app-id'
                M365Environment = 'commercial'
            }
            Scope         = @{ Sections = @('Identity', 'Email') }
            Output        = @{ OutputFolder = (Join-Path -Path $Directory -ChildPath 'assessment') }
            Options       = $Options
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $contextFile -Encoding UTF8
        return $contextFile
    }

    function script:New-ArgumentProbe {
        param(
            [Parameter(Mandatory)]
            [string]$Directory
        )

        $probe = Join-Path -Path $Directory -ChildPath 'argument-probe.ps1'
        @'
param(
    [string]$OutputFolder = '',
    [switch]$SkipPurview,
    [switch]$QuickScan,
    [switch]$Redact,
    [switch]$EvidencePackage,
    [switch]$NonInteractive,
    [Parameter(ValueFromRemainingArguments = $true)]
    $Remaining
)
$ErrorActionPreference = 'Stop'
New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
[ordered]@{
    SkipPurview     = ($PSBoundParameters.ContainsKey('SkipPurview') -and [bool]$SkipPurview)
    QuickScan       = ($PSBoundParameters.ContainsKey('QuickScan') -and [bool]$QuickScan)
    Redact          = ($PSBoundParameters.ContainsKey('Redact') -and [bool]$Redact)
    EvidencePackage = ($PSBoundParameters.ContainsKey('EvidencePackage') -and [bool]$EvidencePackage)
    NonInteractive  = ($PSBoundParameters.ContainsKey('NonInteractive') -and [bool]$NonInteractive)
} | ConvertTo-Json | Set-Content -Path (Join-Path -Path $OutputFolder -ChildPath 'probe.json') -Encoding UTF8
'@ | Set-Content -Path $probe -Encoding UTF8
        return $probe
    }
}

AfterAll {
    Remove-Module -Name 'M365Portal.Workers' -ErrorAction SilentlyContinue
    foreach ($root in $script:scratchRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-WorkerAssessment run options (T-0927)' {

    It 'rehydrates the Options block the portal wrote into context.json' {
        $scratch = New-WorkerScratch
        $contextFile = New-OptionContextFile -Directory $scratch -Options @{
            QuickScan   = $false
            SkipPurview = $true
            Redact      = $false
            Evidence    = $true
        }

        $ctx = Read-WorkerRunContext -ContextFile $contextFile

        $ctx.Options['SkipPurview'] | Should -BeTrue
        $ctx.Options['Evidence'] | Should -BeTrue
        $ctx.Options['Redact'] | Should -BeFalse
        $ctx.Options['QuickScan'] | Should -BeFalse
    }

    It 'maps skipPurview to -SkipPurview so the assessment never connects to Purview' {
        $scratch = New-WorkerScratch
        $contextFile = New-OptionContextFile -Directory $scratch -Options @{
            QuickScan   = $false
            SkipPurview = $true
            Redact      = $false
            Evidence    = $true
        }
        $probe = New-ArgumentProbe -Directory $scratch
        $output = Join-Path -Path $scratch -ChildPath 'tenant'
        $ctx = Read-WorkerRunContext -ContextFile $contextFile

        Invoke-WorkerAssessment -Context $ctx -OutputFolder $output -AssessmentScript $probe

        $seen = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'probe.json') -Raw | ConvertFrom-Json -AsHashtable
        $seen['SkipPurview'] | Should -BeTrue
        $seen['EvidencePackage'] | Should -BeTrue
        $seen['Redact'] | Should -BeFalse
        $seen['QuickScan'] | Should -BeFalse
        $seen['NonInteractive'] | Should -BeTrue
    }

    It 'maps quickScan and redact onto their assessment switches' {
        $scratch = New-WorkerScratch
        $contextFile = New-OptionContextFile -Directory $scratch -Options @{
            QuickScan   = $true
            SkipPurview = $false
            Redact      = $true
            Evidence    = $false
        }
        $probe = New-ArgumentProbe -Directory $scratch
        $output = Join-Path -Path $scratch -ChildPath 'tenant'
        $ctx = Read-WorkerRunContext -ContextFile $contextFile

        Invoke-WorkerAssessment -Context $ctx -OutputFolder $output -AssessmentScript $probe

        $seen = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'probe.json') -Raw | ConvertFrom-Json -AsHashtable
        $seen['QuickScan'] | Should -BeTrue
        $seen['Redact'] | Should -BeTrue
        $seen['SkipPurview'] | Should -BeFalse
        $seen['EvidencePackage'] | Should -BeFalse
    }

    It 'leaves every option switch off when the run chose none' {
        $scratch = New-WorkerScratch
        $contextFile = New-OptionContextFile -Directory $scratch -Options @{
            QuickScan   = $false
            SkipPurview = $false
            Redact      = $false
            Evidence    = $false
        }
        $probe = New-ArgumentProbe -Directory $scratch
        $output = Join-Path -Path $scratch -ChildPath 'tenant'
        $ctx = Read-WorkerRunContext -ContextFile $contextFile

        Invoke-WorkerAssessment -Context $ctx -OutputFolder $output -AssessmentScript $probe

        $seen = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'probe.json') -Raw | ConvertFrom-Json -AsHashtable
        $seen['SkipPurview'] | Should -BeFalse
        $seen['QuickScan'] | Should -BeFalse
        $seen['Redact'] | Should -BeFalse
        $seen['EvidencePackage'] | Should -BeFalse
    }
}
