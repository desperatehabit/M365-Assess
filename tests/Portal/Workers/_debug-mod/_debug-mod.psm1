function Test-Foo {
    $violations = @()
    $violations += 'sandbox.policy_violation: disallowed command: Get-Content'
    return $violations
}
function Test-Bar {
    $v = Test-Foo
    Write-Host "inside module, type: $(if ($null -eq $v) {'null'} else {$v.GetType().FullName})"
    Write-Host "inside module, count: $($v.Count)"
    if ($v -and $v.Count -gt 0) {
        Write-Host 'inside module: condition true'
    } else {
        Write-Host 'inside module: condition false'
    }
}
Export-ModuleMember -Function Test-Bar
