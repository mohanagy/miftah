param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repositoryRoot 'src/secrets/windows-secret-job.cs'
$metadataPath = Join-Path $repositoryRoot 'src/secrets/windows-secret-job-artifact.ts'
$artifactPath = Join-Path $repositoryRoot 'assets/windows-secret-job.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not [IO.File]::Exists($compiler)) { throw 'Trusted .NET Framework C# compiler is unavailable.' }
if (-not [IO.File]::Exists($artifactPath)) { throw 'Checked Windows Job Object executable is unavailable.' }

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("miftah-secret-job-" + [Guid]::NewGuid().ToString('N'))
$compiledPath = Join-Path $temporaryDirectory 'miftah-secret-job.exe'
try {
  [IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
  & $compiler /nologo /target:exe /main:MiftahSecretJob /platform:anycpu /optimize+ "/out:$compiledPath" $sourcePath
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($compiledPath)) {
    throw 'Failed to compile the Windows Job Object executable.'
  }

  # The in-box .NET Framework compiler emits a nondeterministic PE timestamp and MVID, so byte
  # equality is not a stable provenance check. Validate canonical source compilation independently,
  # then validate the checked runtime artifact and both committed fingerprints.
  $compiled = [IO.File]::ReadAllBytes($compiledPath)
  if ($compiled.Length -eq 0 -or $compiled.Length -gt 16384 -or $compiled[0] -ne 0x4d -or $compiled[1] -ne 0x5a) {
    throw 'Canonical Windows Job Object source did not compile to a valid bounded executable.'
  }

  $metadata = [IO.File]::ReadAllText($metadataPath)
  $sourceHashMatch = [regex]::Match(
    $metadata,
    'export const windowsSecretJobSourceSha256 = "([a-f0-9]{64})";',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  $artifactHashMatch = [regex]::Match(
    $metadata,
    'export const windowsSecretJobExecutableSha256 = "([a-f0-9]{64})";',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $sourceHashMatch.Success -or -not $artifactHashMatch.Success) {
    throw 'Windows Job Object fingerprints are unavailable.'
  }

  $normalizedSource = [IO.File]::ReadAllText($sourcePath).Replace("`r`n", "`n").Replace("`r", "`n")
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $sourceHashBytes = $sha256.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($normalizedSource))
    $artifact = [IO.File]::ReadAllBytes($artifactPath)
    $artifactHashBytes = $sha256.ComputeHash($artifact)
  } finally {
    $sha256.Dispose()
  }
  $sourceHash = -join ($sourceHashBytes | ForEach-Object { $_.ToString('x2') })
  $artifactHash = -join ($artifactHashBytes | ForEach-Object { $_.ToString('x2') })
  if ($sourceHash -cne $sourceHashMatch.Groups[1].Value) {
    throw 'Checked Windows Job Object executable is stale relative to its canonical C# source.'
  }
  if ($artifactHash -cne $artifactHashMatch.Groups[1].Value) {
    throw 'Checked Windows Job Object executable fingerprint does not match its runtime artifact.'
  }
  if ($artifact.Length -eq 0 -or $artifact.Length -gt 16384 -or $artifact[0] -ne 0x4d -or $artifact[1] -ne 0x5a) {
    throw 'Checked Windows Job Object executable is invalid or exceeds its runtime bound.'
  }

  $assembly = [Reflection.Assembly]::LoadFile($artifactPath)
  $type = $assembly.GetType('MiftahSecretJob', $true)
  if ($null -eq $type.GetMethod('Main') -or $null -eq $type.GetMethod('Initialize', [Type[]]@()) -or
      $type.GetMethods().Where({ $_.Name -eq 'Run' }).Count -ne 2) {
    throw 'Checked Windows Job Object executable does not expose the required helper contract.'
  }
  & $artifactPath
  if ($LASTEXITCODE -ne 1) {
    throw 'Checked Windows Job Object executable did not reject a missing request at its direct entry point.'
  }
  Write-Output 'Verified Windows helper source compilation and checked direct executable contract.'
} finally {
  if ([IO.Directory]::Exists($temporaryDirectory)) {
    [IO.Directory]::Delete($temporaryDirectory, $true)
  }
}
exit 0
