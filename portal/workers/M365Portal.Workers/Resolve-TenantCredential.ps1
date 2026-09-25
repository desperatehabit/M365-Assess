# Resolve-TenantCredential.ps1 — EPIC-001 tenant credential materialization (SPEC.md §4.4).
#
# Child-process only. The supervisor (parent) never holds secret material: the job
# envelope carries only a credential reference (`credentialRef`), `context.json`
# carries only non-secret auth fields (see ConvertTo-RunContextJson), and this
# function resolves the reference against the credential store here, in the child,
# returning auth material that the caller applies to the in-memory `$ctx.Auth`.
# Thrown messages and redacted logs never contain secret values, only references.

function Resolve-TenantCredential {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', '',
        Justification = 'CredentialRef and CredentialRecord carry storage references, never secret material; that separation is the point of this function.')]
    <#
    .SYNOPSIS
        Materializes a tenant credential from its reference inside the child process.
    .DESCRIPTION
        Validates that -CredentialRef addresses -TenantId and matches the non-secret
        TenantCredential row (-CredentialRecord) the supervisor read from storage,
        resolves secret material through -CredentialStore only when the auth method
        needs it (client secret, PFX), and returns a hashtable shaped for
        New-RunContext -Auth / $ctx.Auth (ClientId, CertificateThumbprint or
        CertificatePath/CertificatePassword or ClientSecret as SecureString,
        M365Environment, Method). Certificate-thumbprint credentials need no store
        access. Client-secret credentials are rejected up front when -Sections
        requires Exchange Online or Purview, which do not accept secrets
        (Connect-Service.ps1 throws there; failing here keeps the error stable
        and out of per-service connect loops). Every failure throws a coded,
        non-secret message (worker.credential_*); the reference may appear, the
        material never does.
    .PARAMETER TenantId
        Tenant the credential belongs to.
    .PARAMETER CredentialRef
        Credential reference from the job envelope payload (credentialRef), of the
        form tenants/<tenantId>/credential, or the row secretRef (ref://...).
    .PARAMETER CredentialRecord
        Non-secret TenantCredential row fields (authMethod, clientId, secretRef,
        thumbprint, environment; tenantId when known). Never carries material.
    .PARAMETER CredentialStore
        Scriptblock param([string]$SecretRef) returning material for the row
        secretRef: the secret string/SecureString for client-secret auth, or a
        hashtable @{ CertificatePath = ...; CertificatePassword = ... } for
        certificate-pfx auth. Omitted when no material is needed; the OS-keystore
        backend is provided by the credential-store ticket (T-0023) against this
        contract. Tests pass a stub.
    .PARAMETER Sections
        Assessment sections about to run, used only for the client-secret vs
        ExchangeOnline/Purview compatibility check.
    .OUTPUTS
        System.Collections.Hashtable
    .EXAMPLE
        PS> $auth = Resolve-TenantCredential -TenantId $id -CredentialRef 'tenants/<id>/credential' -CredentialRecord $row -CredentialStore $store -Sections @('Identity')
        PS> $ctx = New-RunContext -TenantId $id -Auth $auth
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CredentialRef,

        [Parameter(Mandatory)]
        [object]$CredentialRecord,

        [Parameter()]
        [scriptblock]$CredentialStore,

        [Parameter()]
        [string[]]$Sections = @()
    )

    $record = @{}
    foreach ($property in @($CredentialRecord.PSObject.Properties)) {
        $record[$property.Name] = $property.Value
    }
    if ($CredentialRecord -is [hashtable]) {
        foreach ($key in $CredentialRecord.Keys) {
            $record[[string]$key] = $CredentialRecord[$key]
        }
    }

    $rowTenant = [string]$record['tenantId']
    if ($rowTenant -and $rowTenant -ne $TenantId) {
        throw "Tenant credential reference '$CredentialRef' does not belong to this tenant (code: worker.credential_ref_mismatch)."
    }

    $rowRef = [string]$record['secretRef']
    if ($rowRef -and $rowRef -ne $CredentialRef -and "tenants/$TenantId/credential" -ne $CredentialRef) {
        throw "Tenant credential reference '$CredentialRef' does not match the stored credential row (code: worker.credential_ref_mismatch)."
    }

    $authMethod = ([string]$record['authMethod']).Trim().ToLowerInvariant()
    $clientId = [string]$record['clientId']
    $environment = [string]$record['environment']
    if (-not $environment) { $environment = 'commercial' }
    if (-not $clientId) {
        throw "Tenant credential '$CredentialRef' has no client id (code: worker.credential_invalid)."
    }

    switch ($authMethod) {
        { $_ -in @('certificate', 'certificate-thumbprint', 'thumbprint') } {
            $thumbprint = [string]$record['thumbprint']
            if (-not $thumbprint) {
                throw "Tenant credential '$CredentialRef' has no certificate thumbprint (code: worker.credential_invalid)."
            }
            return @{
                Method                = 'Certificate'
                ClientId              = $clientId
                CertificateThumbprint = $thumbprint
                M365Environment       = $environment
            }
        }
        { $_ -in @('certificate-pfx', 'pfx') } {
            $material = Read-WorkerCredentialMaterial -CredentialRef $CredentialRef -SecretRef $rowRef -CredentialStore $CredentialStore
            if ($material -isnot [System.Collections.IDictionary] -and $material -isnot [pscustomobject]) {
                throw "Tenant credential '$CredentialRef' returned no certificate path (code: worker.credential_invalid)."
            }
            $pfx = @{}
            if ($material -is [System.Collections.IDictionary]) {
                foreach ($key in $material.Keys) { $pfx[[string]$key] = $material[$key] }
            }
            else {
                foreach ($property in @($material.PSObject.Properties)) { $pfx[$property.Name] = $property.Value }
            }
            $pfxPath = [string]$pfx['CertificatePath']
            if (-not $pfxPath) {
                throw "Tenant credential '$CredentialRef' returned no certificate path (code: worker.credential_invalid)."
            }
            $auth = @{
                Method           = 'Certificate'
                ClientId         = $clientId
                CertificatePath  = $pfxPath
                M365Environment  = $environment
            }
            if ($null -ne $pfx['CertificatePassword']) {
                $auth['CertificatePassword'] = ConvertTo-WorkerSecureString -Value $pfx['CertificatePassword']
            }
            return $auth
        }
        { $_ -in @('client-secret', 'clientsecret', 'secret') } {
            Assert-WorkerSecretAuthSupported -CredentialRef $CredentialRef -Sections $Sections
            $material = Read-WorkerCredentialMaterial -CredentialRef $CredentialRef -SecretRef $rowRef -CredentialStore $CredentialStore
            $secret = ConvertTo-WorkerSecureString -Value $material
            if ($null -eq $secret) {
                throw "Tenant credential '$CredentialRef' returned no secret material (code: worker.credential_invalid)."
            }
            return @{
                Method          = 'ClientSecret'
                ClientId        = $clientId
                ClientSecret    = $secret
                M365Environment = $environment
            }
        }
        default {
            throw "Tenant credential '$CredentialRef' uses unsupported auth method '$authMethod' (code: worker.credential_invalid)."
        }
    }
}

function Assert-WorkerSecretAuthSupported {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', '',
        Justification = 'CredentialRef is a storage reference, never secret material.')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CredentialRef,

        [Parameter()]
        [string[]]$Sections = @()
    )

    # Section-to-service map is owned by Get-AssessmentMaps (AssessmentMaps.ps1);
    # only the ExchangeOnline/Purview rows are repeated here because those are the
    # services whose SDKs reject client-secret auth (see Connect-Service.ps1).
    $secretBlockedServices = @{
        'Email'     = @('ExchangeOnline')
        'Security'  = @('ExchangeOnline', 'Purview')
        'Inventory' = @('ExchangeOnline')
        'SOC2'      = @('Purview')
    }
    $offenders = @()
    foreach ($section in @($Sections)) {
        if ($secretBlockedServices.ContainsKey($section)) {
            $offenders += $section
        }
    }
    if ($offenders.Count -gt 0) {
        $names = ($offenders | Select-Object -Unique) -join ', '
        throw "Tenant credential '$CredentialRef' uses client-secret auth, which Exchange Online and Purview do not support (sections: $names). Use certificate auth for these sections. (code: worker.credential_unsupported)"
    }
}

function Read-WorkerCredentialMaterial {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', '',
        Justification = 'CredentialRef and SecretRef are storage references, never secret material.')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CredentialRef,

        [Parameter()]
        [string]$SecretRef,

        [Parameter()]
        [scriptblock]$CredentialStore
    )

    $lookupRef = if ($SecretRef) { $SecretRef } else { $CredentialRef }
    if ($null -eq $CredentialStore) {
        throw "Tenant credential '$CredentialRef' requires secret material but no credential store was provided (code: worker.credential_store_required)."
    }
    $material = & $CredentialStore $lookupRef
    if ($null -eq $material -or ($material -is [string] -and -not $material)) {
        throw "Tenant credential '$CredentialRef' could not be resolved from the credential store (code: worker.credential_not_found)."
    }
    return $material
}

function ConvertTo-WorkerSecureString {
    [CmdletBinding()]
    [OutputType([securestring])]
    param(
        [Parameter()]
        [object]$Value
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [securestring]) { return $Value }
    if ($Value -is [hashtable]) { return $null }
    if ($Value -is [System.Collections.IDictionary]) { return $null }
    if ($Value -is [pscustomobject]) { return $null }
    $text = [string]$Value
    if (-not $text) { return $null }
    return (ConvertTo-SecureString -String $text -AsPlainText -Force)
}

function Protect-WorkerSecret {
    <#
    .SYNOPSIS
        Redacts in-memory secret values from a log or error message.
    .DESCRIPTION
        Replaces every occurrence of each supplied secret with [REDACTED] using an
        ordinal comparison. References (credentialRef, secretRef, thumbprints) are
        not secrets and pass through untouched. Secrets stay in memory on this
        call; the return value is safe to log.
    .PARAMETER Message
        The message to redact.
    .PARAMETER Secrets
        Secret values (string or SecureString) to redact. Nulls and empties are ignored.
    .OUTPUTS
        System.String
    .EXAMPLE
        PS> Protect-WorkerSecret -Message $err -Secrets @($plainSecret)
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$Message = '',

        [Parameter()]
        [object[]]$Secrets = @()
    )

    $redacted = [string]$Message
    foreach ($secret in @($Secrets)) {
        $text = $null
        if ($secret -is [securestring]) {
            $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
            try {
                $text = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            }
            finally {
                [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            }
        }
        elseif ($null -ne $secret) {
            $text = [string]$secret
        }
        if (-not $text) { continue }
        $redacted = $redacted.Replace($text, '[REDACTED]', [System.StringComparison]::Ordinal)
    }
    return $redacted
}
