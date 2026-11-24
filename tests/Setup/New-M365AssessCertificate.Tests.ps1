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

Describe 'Find-M365AssessStoreCertificate' {
    BeforeAll {
        $script:subject = 'CN=M365-Assess-contoso.onmicrosoft.com'
        function New-FakeStoreCert {
            param([string]$Thumbprint, [string]$Subject = $script:subject, [bool]$HasPrivateKey = $true, [int]$DaysLeft = 365, [int]$AgeDays = 1)
            [pscustomobject]@{
                Thumbprint    = $Thumbprint
                Subject       = $Subject
                HasPrivateKey = $HasPrivateKey
                NotBefore     = (Get-Date).AddDays(-$AgeDays)
                NotAfter      = (Get-Date).AddDays($DaysLeft)
            }
        }
        function ConvertTo-AppKey {
            param([string]$Thumbprint)
            [pscustomobject]@{ CustomKeyIdentifier = [System.Convert]::FromHexString($Thumbprint) }
        }
        $script:thumbA = 'A' * 40
        $script:thumbB = 'B' * 40
    }

    It 'returns the store certificate whose thumbprint is registered on the app' {
        $hit = Find-M365AssessStoreCertificate -AppKeys @(ConvertTo-AppKey $script:thumbA) -Subject $script:subject -Certificates @(
            New-FakeStoreCert -Thumbprint $script:thumbB
            New-FakeStoreCert -Thumbprint $script:thumbA
        )
        $hit.Thumbprint | Should -Be $script:thumbA
        $hit.CertificatePath | Should -BeNullOrEmpty
    }

    It 'ignores certificates without a private key, expired, or for another subject' {
        $keys = @(ConvertTo-AppKey $script:thumbA)
        Find-M365AssessStoreCertificate -AppKeys $keys -Subject $script:subject -Certificates @(New-FakeStoreCert -Thumbprint $script:thumbA -HasPrivateKey $false) | Should -BeNullOrEmpty
        Find-M365AssessStoreCertificate -AppKeys $keys -Subject $script:subject -Certificates @(New-FakeStoreCert -Thumbprint $script:thumbA -DaysLeft -1) | Should -BeNullOrEmpty
        Find-M365AssessStoreCertificate -AppKeys $keys -Subject $script:subject -Certificates @(New-FakeStoreCert -Thumbprint $script:thumbA -Subject 'CN=Other') | Should -BeNullOrEmpty
    }

    It 'returns nothing when the app has no matching key' {
        Find-M365AssessStoreCertificate -AppKeys @(ConvertTo-AppKey $script:thumbB) -Subject $script:subject -Certificates @(New-FakeStoreCert -Thumbprint $script:thumbA) | Should -BeNullOrEmpty
        Find-M365AssessStoreCertificate -AppKeys @() -Subject $script:subject -Certificates @(New-FakeStoreCert -Thumbprint $script:thumbA) | Should -BeNullOrEmpty
    }

    It 'matches the identifier as the Graph SDK returns it (thumbprint text, base64-decoded)' {
        # Entra stores customKeyIdentifier as the thumbprint text; the SDK base64-decodes it to 30 bytes.
        $thumb = '1063DA4C0EBDD1D013379DC4581A4861215F4B1A'
        $sdkKey = [pscustomobject]@{ CustomKeyIdentifier = [System.Convert]::FromBase64String($thumb) }
        $sdkKey.CustomKeyIdentifier.Length | Should -Be 30

        $hit = Find-M365AssessStoreCertificate -AppKeys @($sdkKey) -Subject $script:subject -Certificates @(New-FakeStoreCert -Thumbprint $thumb)
        $hit.Thumbprint | Should -Be $thumb
    }

    It 'prefers the newest matching certificate' {
        $older = New-FakeStoreCert -Thumbprint $script:thumbA -AgeDays 30
        $newer = New-FakeStoreCert -Thumbprint $script:thumbB -AgeDays 1
        $hit = Find-M365AssessStoreCertificate -AppKeys @((ConvertTo-AppKey $script:thumbA), (ConvertTo-AppKey $script:thumbB)) -Subject $script:subject -Certificates @($older, $newer)
        $hit.Thumbprint | Should -Be $script:thumbB
    }
}
