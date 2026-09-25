@{
    RootModule        = 'M365Portal.Workers.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'a22759c2-daa7-4400-b152-1126ccc967ea'
    Author            = 'M365-Assess'
    CompanyName       = 'Community'
    Copyright         = '(c) 2026 M365-Assess. All rights reserved.'
    Description       = 'Per-tenant worker handlers for the M365-Assess portal: RunContext rehydration, assessment invocation, artifact enumeration, and result-envelope emission.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @(
        'Read-WorkerRunContext',
        'Get-WorkerArtifacts',
        'Write-WorkerResult',
        'Invoke-WorkerAssessment'
    )
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
