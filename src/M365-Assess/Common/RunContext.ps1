<#
.SYNOPSIS
    RunContext type and New-RunContext factory for explicit assessment state.
.DESCRIPTION
    Collapses the caller-scope variables and process/script run state that
    Connect-RequiredService currently reads into one object threaded explicitly
    through the orchestrator (EPIC-001 SPEC.md §4.1).

    The context is split into immutable configuration (Tenant, Auth, Scope,
    Output, Paths) and mutable run state (Services, Registry, Issues). The
    child-process boundary serializes the context with ConvertTo-RunContextJson
    and rehydrates it with ConvertFrom-RunContextJson; secret-bearing auth
    members are never written to the serialized shape.
.NOTES
    Author: Daren9m
#>

class RunContextTenant {
    [string]$TenantId = ''
    [string]$DisplayName = ''
    [string]$DefaultDomain = ''
    [string]$InitialDomain = ''
}

class RunContextAuth {
    [string]$Method = ''
    [string]$ClientId = ''
    [string]$CertificateThumbprint = ''
    [object]$Certificate = $null
    [string]$CertificatePath = ''
    [securestring]$CertificatePassword = $null
    [securestring]$ClientSecret = $null
    [string]$UserPrincipalName = ''
    [bool]$ManagedIdentity = $false
    [bool]$UseDeviceCode = $false
    [string]$M365Environment = 'commercial'
}

class RunContextScope {
    [string[]]$Sections = @()
    [string[]]$GraphScopes = @()
    [hashtable]$SectionScopeMap = @{}
    [bool]$QuickScan = $false
    [string[]]$SeverityFilter = @()
}

class RunContextOutput {
    [string]$OutputFolder = ''
    [string]$AssessmentFolder = ''
    [string]$Timestamp = ''
    [string]$DomainPrefix = ''
    [string]$LogFilePath = ''
    [string]$LogFileName = ''
}

class RunContextServices {
    [System.Collections.Generic.HashSet[string]]$Connected
    [System.Collections.Generic.HashSet[string]]$Failed
    [bool]$PermissionsChecked = $false
    [bool]$LicensesResolved = $false

    RunContextServices() {
        $this.Connected = [System.Collections.Generic.HashSet[string]]::new()
        $this.Failed = [System.Collections.Generic.HashSet[string]]::new()
    }
}

class RunContextRegistry {
    [object]$ControlRegistry = $null
    [object]$ProgressState = $null
}

class RunContextPaths {
    [string]$ProjectRoot = ''
    [string]$ConnectServicePath = ''
}

class RunContext {
    [RunContextTenant]$Tenant
    [RunContextAuth]$Auth
    [RunContextScope]$Scope
    [RunContextOutput]$Output
    [RunContextServices]$Services
    [RunContextRegistry]$Registry
    [System.Collections.Generic.List[PSCustomObject]]$Issues
    [RunContextPaths]$Paths

    RunContext() {
        $this.Tenant = [RunContextTenant]::new()
        $this.Auth = [RunContextAuth]::new()
        $this.Scope = [RunContextScope]::new()
        $this.Output = [RunContextOutput]::new()
        $this.Services = [RunContextServices]::new()
        $this.Registry = [RunContextRegistry]::new()
        $this.Issues = [System.Collections.Generic.List[PSCustomObject]]::new()
        $this.Paths = [RunContextPaths]::new()
    }
}

function New-RunContext {
    <#
    .SYNOPSIS
        Builds a RunContext from tenant, auth, scope, output, and path inputs.
    .DESCRIPTION
        Factory for the single explicit assessment state object. Applies the same
        defaults as the CLI: the default output folder, timestamped assessment
        folder, onmicrosoft/custom-domain prefix extraction, and QuickScan
        severity filter. Auth secrets stay on the in-memory object and are never
        required for construction.
    .PARAMETER TenantId
        Tenant ID or domain.
    .PARAMETER DisplayName
        Resolved tenant display name.
    .PARAMETER DefaultDomain
        Resolved primary verified domain.
    .PARAMETER InitialDomain
        Resolved initial (onmicrosoft) domain.
    .PARAMETER Auth
        Auth configuration hashtable. Recognised keys: Method, ClientId,
        CertificateThumbprint, Certificate, CertificatePath, CertificatePassword,
        ClientSecret, UserPrincipalName, ManagedIdentity, UseDeviceCode,
        M365Environment. Method is inferred when omitted.
    .PARAMETER Sections
        Assessment sections to run.
    .PARAMETER GraphScopes
        Combined Graph scopes for the selected sections.
    .PARAMETER SectionScopeMap
        Section-to-Graph-scope map used for permission checks.
    .PARAMETER QuickScan
        Restricts checks to Critical and High severity.
    .PARAMETER SeverityFilter
        Explicit severity filter. Defaults to Critical, High when -QuickScan.
    .PARAMETER OutputFolder
        Root folder for assessment output. Defaults to '.\M365-Assessment'.
    .PARAMETER AssessmentFolder
        Timestamped run folder. Derived from OutputFolder + Timestamp + DomainPrefix.
    .PARAMETER Timestamp
        Run timestamp (yyyyMMdd_HHmmss). Defaults to now.
    .PARAMETER DomainPrefix
        Output-name prefix. Derived from TenantId when omitted.
    .PARAMETER LogFilePath
        Assessment log path. Defaults to AssessmentFolder + LogFileName.
    .PARAMETER LogFileName
        Assessment log file name. Defaults to '_Assessment-Log[_prefix].txt'.
    .PARAMETER ProjectRoot
        Module root. Defaults to the parent of this file's folder.
    .PARAMETER ConnectServicePath
        Path to Connect-Service.ps1. Defaults to ProjectRoot/Common/Connect-Service.ps1.
    .OUTPUTS
        RunContext
    .EXAMPLE
        PS> $ctx = New-RunContext -TenantId 'contoso.onmicrosoft.com' -Sections @('Identity') -Auth @{ Method = 'Interactive' }
    #>
    [CmdletBinding()]
    [OutputType([RunContext])]
    param(
        [Parameter()]
        [string]$TenantId = '',

        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [string]$DefaultDomain = '',

        [Parameter()]
        [string]$InitialDomain = '',

        [Parameter()]
        [hashtable]$Auth = @{},

        [Parameter()]
        [ValidateNotNullOrEmpty()]
        [string[]]$Sections = @('Tenant', 'Identity', 'Licensing', 'Email', 'Intune', 'Security', 'Collaboration', 'PowerBI', 'Hybrid'),

        [Parameter()]
        [string[]]$GraphScopes = @(),

        [Parameter()]
        [hashtable]$SectionScopeMap = @{},

        [Parameter()]
        [switch]$QuickScan,

        [Parameter()]
        [string[]]$SeverityFilter,

        [Parameter()]
        [ValidateNotNullOrEmpty()]
        [string]$OutputFolder = '.\M365-Assessment',

        [Parameter()]
        [string]$AssessmentFolder = '',

        [Parameter()]
        [string]$Timestamp = '',

        [Parameter()]
        [string]$DomainPrefix,

        [Parameter()]
        [string]$LogFilePath = '',

        [Parameter()]
        [string]$LogFileName = '',

        [Parameter()]
        [string]$ProjectRoot = '',

        [Parameter()]
        [string]$ConnectServicePath = ''
    )

    if (-not $Timestamp) { $Timestamp = Get-Date -Format 'yyyyMMdd_HHmmss' }

    if (-not $PSBoundParameters.ContainsKey('DomainPrefix')) {
        $DomainPrefix = ''
        if ($TenantId -match '^([^.]+)\.onmicrosoft\.(com|us)$') {
            $DomainPrefix = $Matches[1]
        }
        elseif ($TenantId -match '^([^.]+)\.' -and $TenantId -notmatch '^[0-9a-f]{8}-') {
            $DomainPrefix = $Matches[1]
        }
    }

    $folderSuffix = if ($DomainPrefix) { "_$DomainPrefix" } else { '' }

    if (-not $AssessmentFolder) {
        $AssessmentFolder = Join-Path -Path $OutputFolder -ChildPath "Assessment_${Timestamp}${folderSuffix}"
    }
    if (-not $LogFileName) {
        $LogFileName = "_Assessment-Log${folderSuffix}.txt"
    }
    if (-not $LogFilePath) {
        $LogFilePath = Join-Path -Path $AssessmentFolder -ChildPath $LogFileName
    }
    if (-not $PSBoundParameters.ContainsKey('SeverityFilter')) {
        $SeverityFilter = if ($QuickScan) { @('Critical', 'High') } else { @() }
    }
    if (-not $ProjectRoot -and $PSScriptRoot) {
        $ProjectRoot = Split-Path -Parent $PSScriptRoot
    }
    if (-not $ConnectServicePath -and $ProjectRoot) {
        $ConnectServicePath = Join-Path -Path $ProjectRoot -ChildPath 'Common/Connect-Service.ps1'
    }

    $ctx = [RunContext]::new()
    $ctx.Tenant.TenantId = $TenantId
    $ctx.Tenant.DisplayName = $DisplayName
    $ctx.Tenant.DefaultDomain = $DefaultDomain
    $ctx.Tenant.InitialDomain = $InitialDomain

    $authKeys = @(
        'Method', 'ClientId', 'CertificateThumbprint', 'Certificate', 'CertificatePath',
        'CertificatePassword', 'ClientSecret', 'UserPrincipalName', 'ManagedIdentity',
        'UseDeviceCode', 'M365Environment'
    )
    foreach ($key in $authKeys) {
        if ($Auth.ContainsKey($key)) {
            $ctx.Auth.$key = $Auth[$key]
        }
    }
    if (-not $ctx.Auth.Method) {
        $ctx.Auth.Method = Resolve-RunContextAuthMethod -Auth $ctx.Auth
    }

    $ctx.Scope.Sections = if ($null -ne $Sections) { @($Sections) } else { @() }
    $ctx.Scope.GraphScopes = if ($null -ne $GraphScopes) { @($GraphScopes) } else { @() }
    $ctx.Scope.SectionScopeMap = if ($SectionScopeMap) { $SectionScopeMap } else { @{} }
    $ctx.Scope.QuickScan = [bool]$QuickScan
    $ctx.Scope.SeverityFilter = if ($null -ne $SeverityFilter) { @($SeverityFilter) } else { @() }

    $ctx.Output.OutputFolder = $OutputFolder
    $ctx.Output.AssessmentFolder = $AssessmentFolder
    $ctx.Output.Timestamp = $Timestamp
    $ctx.Output.DomainPrefix = $DomainPrefix
    $ctx.Output.LogFilePath = $LogFilePath
    $ctx.Output.LogFileName = $LogFileName

    $ctx.Paths.ProjectRoot = $ProjectRoot
    $ctx.Paths.ConnectServicePath = $ConnectServicePath

    return $ctx
}

function Resolve-RunContextAuthMethod {
    <#
    .SYNOPSIS
        Infers the auth method from the supplied auth material.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [RunContextAuth]$Auth
    )

    if ($Auth.ManagedIdentity) { return 'ManagedIdentity' }
    if ($Auth.UseDeviceCode) { return 'DeviceCode' }
    if ($Auth.CertificateThumbprint -or $Auth.Certificate -or $Auth.CertificatePath) { return 'Certificate' }
    if ($Auth.ClientSecret) { return 'ClientSecret' }
    return 'Interactive'
}

function ConvertTo-RunContextJson {
    <#
    .SYNOPSIS
        Serializes a RunContext to plain JSON for the child-process boundary.
    .DESCRIPTION
        Emits only plain data. Secret-bearing auth members (Certificate,
        CertificatePassword, ClientSecret) are deliberately omitted: the child
        process materializes credentials from the credential store and passes
        them into the context after rehydrating (EPIC-001 SPEC.md §4.4).
    .PARAMETER Context
        The RunContext to serialize.
    .PARAMETER Depth
        Maximum JSON nesting depth.
    .OUTPUTS
        System.String
    .EXAMPLE
        PS> ConvertTo-RunContextJson -Context $ctx
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [RunContext]$Context,

        [Parameter()]
        [int]$Depth = 20
    )

    $data = [ordered]@{
        SchemaVersion = 1
        Tenant   = [ordered]@{
            TenantId      = $Context.Tenant.TenantId
            DisplayName   = $Context.Tenant.DisplayName
            DefaultDomain = $Context.Tenant.DefaultDomain
            InitialDomain = $Context.Tenant.InitialDomain
        }
        Auth     = [ordered]@{
            Method                = $Context.Auth.Method
            ClientId              = $Context.Auth.ClientId
            CertificateThumbprint = $Context.Auth.CertificateThumbprint
            CertificatePath       = $Context.Auth.CertificatePath
            UserPrincipalName     = $Context.Auth.UserPrincipalName
            ManagedIdentity       = $Context.Auth.ManagedIdentity
            UseDeviceCode         = $Context.Auth.UseDeviceCode
            M365Environment       = $Context.Auth.M365Environment
        }
        Scope    = [ordered]@{
            Sections        = @($Context.Scope.Sections)
            GraphScopes     = @($Context.Scope.GraphScopes)
            SectionScopeMap = $Context.Scope.SectionScopeMap
            QuickScan       = $Context.Scope.QuickScan
            SeverityFilter  = @($Context.Scope.SeverityFilter)
        }
        Output   = [ordered]@{
            OutputFolder     = $Context.Output.OutputFolder
            AssessmentFolder = $Context.Output.AssessmentFolder
            Timestamp        = $Context.Output.Timestamp
            DomainPrefix     = $Context.Output.DomainPrefix
            LogFilePath      = $Context.Output.LogFilePath
            LogFileName      = $Context.Output.LogFileName
        }
        Services = [ordered]@{
            Connected          = @($Context.Services.Connected)
            Failed             = @($Context.Services.Failed)
            PermissionsChecked = $Context.Services.PermissionsChecked
            LicensesResolved   = $Context.Services.LicensesResolved
        }
        Registry = [ordered]@{
            ControlRegistry = $Context.Registry.ControlRegistry
            ProgressState   = $Context.Registry.ProgressState
        }
        Issues   = @($Context.Issues)
        Paths    = [ordered]@{
            ProjectRoot        = $Context.Paths.ProjectRoot
            ConnectServicePath = $Context.Paths.ConnectServicePath
        }
    }

    return ($data | ConvertTo-Json -Depth $Depth)
}

function ConvertFrom-RunContextJson {
    <#
    .SYNOPSIS
        Rehydrates a RunContext from JSON produced by ConvertTo-RunContextJson.
    .PARAMETER Json
        The serialized context JSON.
    .OUTPUTS
        RunContext
    .EXAMPLE
        PS> ConvertFrom-RunContextJson -Json (Get-Content ./context.json -Raw)
    #>
    [CmdletBinding()]
    [OutputType([RunContext])]
    param(
        [Parameter(Mandatory)]
        [string]$Json
    )

    $data = $Json | ConvertFrom-Json -AsHashtable
    $ctx = [RunContext]::new()

    if ($data.Tenant) {
        $ctx.Tenant.TenantId = [string]$data.Tenant.TenantId
        $ctx.Tenant.DisplayName = [string]$data.Tenant.DisplayName
        $ctx.Tenant.DefaultDomain = [string]$data.Tenant.DefaultDomain
        $ctx.Tenant.InitialDomain = [string]$data.Tenant.InitialDomain
    }
    if ($data.Auth) {
        $ctx.Auth.Method = [string]$data.Auth.Method
        $ctx.Auth.ClientId = [string]$data.Auth.ClientId
        $ctx.Auth.CertificateThumbprint = [string]$data.Auth.CertificateThumbprint
        $ctx.Auth.CertificatePath = [string]$data.Auth.CertificatePath
        $ctx.Auth.UserPrincipalName = [string]$data.Auth.UserPrincipalName
        $ctx.Auth.ManagedIdentity = [bool]$data.Auth.ManagedIdentity
        $ctx.Auth.UseDeviceCode = [bool]$data.Auth.UseDeviceCode
        if ($data.Auth.M365Environment) { $ctx.Auth.M365Environment = [string]$data.Auth.M365Environment }
    }
    if ($data.Scope) {
        $ctx.Scope.Sections = @($data.Scope.Sections | Where-Object { $null -ne $_ })
        $ctx.Scope.GraphScopes = @($data.Scope.GraphScopes | Where-Object { $null -ne $_ })
        if ($data.Scope.SectionScopeMap) { $ctx.Scope.SectionScopeMap = $data.Scope.SectionScopeMap }
        $ctx.Scope.QuickScan = [bool]$data.Scope.QuickScan
        $ctx.Scope.SeverityFilter = @($data.Scope.SeverityFilter | Where-Object { $null -ne $_ })
    }
    if ($data.Output) {
        $ctx.Output.OutputFolder = [string]$data.Output.OutputFolder
        $ctx.Output.AssessmentFolder = [string]$data.Output.AssessmentFolder
        $ctx.Output.Timestamp = [string]$data.Output.Timestamp
        $ctx.Output.DomainPrefix = [string]$data.Output.DomainPrefix
        $ctx.Output.LogFilePath = [string]$data.Output.LogFilePath
        $ctx.Output.LogFileName = [string]$data.Output.LogFileName
    }
    if ($data.Services) {
        foreach ($svc in @($data.Services.Connected | Where-Object { $null -ne $_ })) {
            [void]$ctx.Services.Connected.Add([string]$svc)
        }
        foreach ($svc in @($data.Services.Failed | Where-Object { $null -ne $_ })) {
            [void]$ctx.Services.Failed.Add([string]$svc)
        }
        $ctx.Services.PermissionsChecked = [bool]$data.Services.PermissionsChecked
        $ctx.Services.LicensesResolved = [bool]$data.Services.LicensesResolved
    }
    if ($data.Registry) {
        $ctx.Registry.ControlRegistry = $data.Registry.ControlRegistry
        $ctx.Registry.ProgressState = $data.Registry.ProgressState
    }
    foreach ($issue in @($data.Issues | Where-Object { $null -ne $_ })) {
        $ctx.Issues.Add([PSCustomObject]$issue)
    }
    if ($data.Paths) {
        $ctx.Paths.ProjectRoot = [string]$data.Paths.ProjectRoot
        $ctx.Paths.ConnectServicePath = [string]$data.Paths.ConnectServicePath
    }

    return $ctx
}
