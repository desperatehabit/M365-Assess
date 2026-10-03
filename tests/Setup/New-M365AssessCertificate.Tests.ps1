BeforeAll {
    . "$PSScriptRoot/../../src/M365-Assess/Setup/New-M365AssessCertificate.ps1"
}

Describe 'New-M365AssessCertificate' {
    BeforeAll {
        $script:outDir = Join-Path $TestDrive 'certs'
        $script:result = New-M365AssessCertificate -Subject 'CN=M365-Assess-test' -ExpiryYears 2 `
            -OutputDirectory $script:outDir -BaseName 'M365-Assess-test/tenant'
    }

    It 'creates the output directory and writes the PFX and CER files' {
        Test-Path -LiteralPath $script:result.CertificatePath | Should -BeTrue
        Test-Path -LiteralPath $script:result.CerPath | Should -BeTrue
    }

    It 'sanitizes the base name so it cannot escape the output directory' {
        (Split-Path -Path $script:result.CertificatePath -Parent) | Should -Be $script:outDir
        (Split-Path -Path $script:result.CertificatePath -Leaf) | Should -Be "M365-Assess-test_tenant-$($script:result.Thumbprint.Substring(0, 8).ToLowerInvariant()).pfx"
    }

    It 'writes a PFX that loads without a password and holds the private key' {
        $loaded = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($script:result.CertificatePath)
        $loaded.HasPrivateKey | Should -BeTrue
        $loaded.Thumbprint | Should -Be $script:result.Thumbprint
        $loaded.Subject | Should -Be 'CN=M365-Assess-test'
    }

    It 'writes a public-only CER matching the PFX' {
        $cer = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($script:result.CerPath)
        $cer.HasPrivateKey | Should -BeFalse
        $cer.Thumbprint | Should -Be $script:result.Thumbprint
    }

    It 'is valid now and for the requested number of years' {
        $cert = $script:result.Certificate
        $cert.NotBefore | Should -BeLessThan (Get-Date)
        $cert.NotAfter | Should -BeGreaterThan (Get-Date).AddYears(2).AddDays(-1)
        $cert.NotAfter | Should -BeLessThan (Get-Date).AddYears(2).AddDays(1)
    }

    It 'restricts the key material to the owner on Unix' -Skip:(-not ($IsLinux -or $IsMacOS)) {
        [int](Get-Item -LiteralPath $script:result.CertificatePath).UnixFileMode | Should -Be 0x180   # 0600
        [int](Get-Item -LiteralPath $script:outDir).UnixFileMode | Should -Be 0x1C0   # 0700
    }
}

Describe 'Find-M365AssessCertificate' {
    BeforeAll {
        $script:dir = Join-Path $TestDrive 'find'
        $script:mine = New-M365AssessCertificate -Subject 'CN=M365-Assess-t' -ExpiryYears 2 -OutputDirectory $script:dir -BaseName 'M365-Assess-t'
        $script:other = New-M365AssessCertificate -Subject 'CN=M365-Assess-t' -ExpiryYears 2 -OutputDirectory $script:dir -BaseName 'M365-Assess-t'
        $script:keyFor = { param($thumb) [pscustomobject]@{ CustomKeyIdentifier = [byte[]]@(for ($i = 0; $i -lt $thumb.Length; $i += 2) { [Convert]::ToByte($thumb.Substring($i, 2), 16) }) } }
    }

    It 'keeps each certificate in its own file' {
        $script:mine.CertificatePath | Should -Not -Be $script:other.CertificatePath
    }

    It 'returns the PFX whose thumbprint is registered on the app' {
        $found = Find-M365AssessCertificate -AppKeys @(& $script:keyFor $script:mine.Thumbprint) -Directory $script:dir -BaseName 'M365-Assess-t'
        $found.Thumbprint | Should -Be $script:mine.Thumbprint
        $found.CertificatePath | Should -Be $script:mine.CertificatePath
        $found.Certificate.HasPrivateKey | Should -BeTrue
    }

    It 'returns nothing when no local key matches the app' {
        $stranger = & $script:keyFor ('AB' * 20)
        Find-M365AssessCertificate -AppKeys @($stranger) -Directory $script:dir -BaseName 'M365-Assess-t' | Should -BeNullOrEmpty
    }

    It 'returns nothing when the app has no key credentials or the directory is missing' {
        Find-M365AssessCertificate -AppKeys @() -Directory $script:dir -BaseName 'M365-Assess-t' | Should -BeNullOrEmpty
        Find-M365AssessCertificate -AppKeys @(& $script:keyFor $script:mine.Thumbprint) -Directory (Join-Path $TestDrive 'nope') -BaseName 'M365-Assess-t' | Should -BeNullOrEmpty
    }
}
