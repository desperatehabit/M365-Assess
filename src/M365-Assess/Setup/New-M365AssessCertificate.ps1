function New-M365AssessCertificate {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Private setup helper called from Grant-M365AssessConsent, which owns the ShouldProcess confirmation.')]
    <#
    .SYNOPSIS
        SETUP HELPER. Creates a self-signed app-only authentication certificate as a PFX file,
        without the Windows certificate store.
    .DESCRIPTION
        New-SelfSignedCertificate and the Cert: drive exist only on Windows. This builds the
        certificate with .NET (CertificateRequest), so it works on Windows, Linux and macOS, and
        writes two files into -OutputDirectory:
          - a PFX holding the private key, for the app-only sign-in (-CertificatePath)
          - a .cer holding the public key, for upload to the app registration
        The PFX has no password: it is protected by owner-only permissions (0700 directory, 0600
        file), the same model as the portal credential store. On Windows, where chmod is not
        available, the profile directory ACLs apply.
    .PARAMETER Subject
        Certificate subject, for example 'CN=M365-Assess-contoso.onmicrosoft.com'.
    .PARAMETER ExpiryYears
        Validity period in years.
    .PARAMETER OutputDirectory
        Directory for the generated files. Created with owner-only permissions when missing.
    .PARAMETER BaseName
        File name stem. The certificate's short thumbprint is appended, so a second certificate
        for the same tenant never overwrites the private key of an earlier app registration.
    .OUTPUTS
        PSCustomObject with Certificate (X509Certificate2), Thumbprint, CertificatePath, CerPath.
    .EXAMPLE
        New-M365AssessCertificate -Subject 'CN=M365-Assess-contoso' -ExpiryYears 2 -OutputDirectory ~/.m365-assess/certs -BaseName 'M365-Assess-contoso'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Subject,

        [Parameter()]
        [ValidateRange(1, 10)]
        [int]$ExpiryYears = 2,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$OutputDirectory,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$BaseName
    )

    $isUnix = $IsLinux -or $IsMacOS
    $safeName = $BaseName -replace '[^A-Za-z0-9._-]', '_'

    if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    }
    # Owner-only before any key material is written, so the key is never readable by others.
    if ($isUnix) { & chmod 700 $OutputDirectory }

    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        $Subject,
        $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    # Backdate slightly so clock skew against Entra does not reject the key as not yet valid.
    $notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $cert = $request.CreateSelfSigned($notBefore, $notBefore.AddYears($ExpiryYears))

    $stem = "$safeName-$($cert.Thumbprint.Substring(0, 8).ToLowerInvariant())"
    $pfxPath = Join-Path -Path $OutputDirectory -ChildPath "$stem.pfx"
    $cerPath = Join-Path -Path $OutputDirectory -ChildPath "$stem.cer"
    [System.IO.File]::WriteAllBytes($pfxPath, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
    [System.IO.File]::WriteAllBytes($cerPath, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    if ($isUnix) { & chmod 600 $pfxPath }

    [PSCustomObject]@{
        Certificate     = $cert
        Thumbprint      = $cert.Thumbprint
        CertificatePath = $pfxPath
        CerPath         = $cerPath
    }
}

function Get-M365AssessRegisteredThumbprint {
    <#
    .SYNOPSIS
        SETUP HELPER. Returns the certificate thumbprints an application's key credentials identify.
    .DESCRIPTION
        Entra stores a certificate key's customKeyIdentifier as the thumbprint text (40 hex
        characters), and the Graph SDK hands it back base64-decoded, as 30 bytes. Re-encoding
        those bytes as base64 gives the thumbprint. A raw SHA-1 thumbprint (20 bytes) is also
        accepted, read as hex. Both candidates are returned upper-cased.
    .PARAMETER AppKeys
        The application's KeyCredentials.
    .EXAMPLE
        Get-M365AssessRegisteredThumbprint -AppKeys $app.KeyCredentials
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [object[]]$AppKeys = @()
    )

    foreach ($key in @($AppKeys | Where-Object { $_ -and $_.CustomKeyIdentifier })) {
        $bytes = [byte[]]$key.CustomKeyIdentifier
        [System.BitConverter]::ToString($bytes).Replace('-', '').ToUpperInvariant()
        [System.Convert]::ToBase64String($bytes).ToUpperInvariant()
    }
}

function Find-M365AssessStoreCertificate {
    <#
    .SYNOPSIS
        SETUP HELPER. Finds a certificate in the Windows store whose public key is registered on an app.
    .DESCRIPTION
        The Windows counterpart of Find-M365AssessCertificate. On Windows the bootstrap writes the
        certificate to Cert:\CurrentUser\My rather than a PFX file, so a re-run after a partial
        onboarding looks there. Returns the newest unexpired certificate with the given subject
        and a private key whose thumbprint matches a key credential on the application.
    .PARAMETER AppKeys
        The application's KeyCredentials (each carries CustomKeyIdentifier, the SHA-1 thumbprint bytes).
    .PARAMETER Subject
        The certificate subject the bootstrap used, e.g. 'CN=M365-Assess-contoso.onmicrosoft.com'.
    .PARAMETER Certificates
        Test seam: the certificates to search instead of Cert:\CurrentUser\My.
    .OUTPUTS
        PSCustomObject with Certificate and Thumbprint (CertificatePath and CerPath are $null,
        since the key lives in the store); $null when none match.
    .EXAMPLE
        Find-M365AssessStoreCertificate -AppKeys $app.KeyCredentials -Subject 'CN=M365-Assess-contoso.onmicrosoft.com'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [object[]]$AppKeys = @(),

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Subject,

        [Parameter()]
        [object[]]$Certificates
    )

    $registered = @(Get-M365AssessRegisteredThumbprint -AppKeys $AppKeys)
    if ($registered.Count -eq 0) { return $null }

    if ($null -eq $Certificates) {
        $Certificates = @(Get-ChildItem -Path 'Cert:\CurrentUser\My' -ErrorAction SilentlyContinue)
    }
    $now = Get-Date
    $match = @($Certificates | Where-Object {
            $_.Subject -eq $Subject -and $_.HasPrivateKey -and $_.NotAfter -gt $now -and
            ($registered -contains $_.Thumbprint.ToUpperInvariant())
        } | Sort-Object -Property NotBefore -Descending) | Select-Object -First 1
    if (-not $match) { return $null }
    return [PSCustomObject]@{
        Certificate     = $match
        Thumbprint      = $match.Thumbprint
        CertificatePath = $null
        CerPath         = $null
    }
}

function Find-M365AssessCertificate {
    <#
    .SYNOPSIS
        SETUP HELPER. Finds a previously generated PFX whose public key is registered on an app.
    .DESCRIPTION
        Lets a re-run resume an app registration whose onboarding stopped part way, instead of
        failing on the duplicate name. Scans -Directory for PFX files that
        New-M365AssessCertificate wrote for -BaseName, and returns the first unexpired one whose
        thumbprint matches a key credential on the application.
    .PARAMETER AppKeys
        The application's KeyCredentials (each carries CustomKeyIdentifier, the SHA-1 thumbprint bytes).
    .PARAMETER Directory
        Directory holding the generated PFX files.
    .PARAMETER BaseName
        The same -BaseName passed to New-M365AssessCertificate.
    .OUTPUTS
        PSCustomObject with Certificate, Thumbprint, CertificatePath, CerPath; $null when none match.
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [object[]]$AppKeys = @(),

        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [string]$BaseName
    )

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $null }

    $registered = @(Get-M365AssessRegisteredThumbprint -AppKeys $AppKeys)
    if ($registered.Count -eq 0) { return $null }

    $safeName = $BaseName -replace '[^A-Za-z0-9._-]', '_'
    foreach ($file in @(Get-ChildItem -LiteralPath $Directory -Filter "$safeName-*.pfx" -File -ErrorAction SilentlyContinue)) {
        try {
            $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($file.FullName)
        }
        catch {
            Write-Verbose "Skipping unreadable certificate file '$($file.Name)': $($_.Exception.Message)"
            continue
        }
        if ($cert.NotAfter -le (Get-Date)) { continue }
        if ($registered -contains $cert.Thumbprint.ToUpperInvariant()) {
            return [PSCustomObject]@{
                Certificate     = $cert
                Thumbprint      = $cert.Thumbprint
                CertificatePath = $file.FullName
                CerPath         = [System.IO.Path]::ChangeExtension($file.FullName, '.cer')
            }
        }
    }
    return $null
}
