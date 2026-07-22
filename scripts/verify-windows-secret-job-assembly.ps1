param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repositoryRoot 'src/secrets/windows-secret-job.cs'
$generatedPath = Join-Path $repositoryRoot 'src/secrets/windows-secret-job-assembly.ts'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not [IO.File]::Exists($compiler)) { throw 'Trusted .NET Framework C# compiler is unavailable.' }

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("miftah-secret-job-" + [Guid]::NewGuid().ToString('N'))
$compiledPath = Join-Path $temporaryDirectory 'miftah-secret-job.dll'
try {
  [IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
  & $compiler /nologo /target:library /platform:anycpu /optimize+ "/out:$compiledPath" $sourcePath
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($compiledPath)) {
    throw 'Failed to compile the Windows Job Object helper.'
  }
  # The in-box .NET Framework compiler emits a nondeterministic PE timestamp and MVID, so byte
  # equality is not a stable provenance check. Validate that canonical source independently
  # compiles to a bounded PE, then validate the checked runtime artifact and its source fingerprint.
  $compiled = [IO.File]::ReadAllBytes($compiledPath)
  if ($compiled.Length -eq 0 -or $compiled.Length -gt 16384 -or $compiled[0] -ne 0x4d -or $compiled[1] -ne 0x5a) {
    throw 'Canonical Windows Job Object source did not compile to a valid bounded assembly.'
  }

  $generatedSource = [IO.File]::ReadAllText($generatedPath)
  $assemblyMatch = [regex]::Match(
    $generatedSource,
    'export const encodedWindowsSecretJobAssembly = "([A-Za-z0-9+/=]+)";',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $assemblyMatch.Success) { throw 'Generated Windows Job Object assembly is unavailable.' }
  if ($assemblyMatch.Groups[1].Value.Length -gt 8192) {
    throw 'Generated Windows Job Object assembly exceeds its encoded runtime bound.'
  }
  $sourceHashMatch = [regex]::Match(
    $generatedSource,
    'export const windowsSecretJobSourceSha256 = "([a-f0-9]{64})";',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $sourceHashMatch.Success) { throw 'Windows Job Object source fingerprint is unavailable.' }
  $normalizedSource = [IO.File]::ReadAllText($sourcePath).Replace("`r`n", "`n").Replace("`r", "`n")
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $sourceHashBytes = $sha256.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($normalizedSource))
  } finally {
    $sha256.Dispose()
  }
  $sourceHash = -join ($sourceHashBytes | ForEach-Object { $_.ToString('x2') })
  if ($sourceHash -cne $sourceHashMatch.Groups[1].Value) {
    throw 'Generated Windows Job Object assembly is stale relative to its canonical C# source.'
  }

  $compressedInput = [IO.MemoryStream]::new([Convert]::FromBase64String($assemblyMatch.Groups[1].Value), $false)
  $gzip = [IO.Compression.GzipStream]::new($compressedInput, [IO.Compression.CompressionMode]::Decompress, $false)
  $embeddedOutput = [IO.MemoryStream]::new()
  try {
    $gzip.CopyTo($embeddedOutput)
  } finally {
    $gzip.Dispose()
    $compressedInput.Dispose()
  }

  $embedded = $embeddedOutput.ToArray()
  $embeddedOutput.Dispose()
  if ($embedded.Length -eq 0 -or $embedded.Length -gt 16384 -or $embedded[0] -ne 0x4d -or $embedded[1] -ne 0x5a) {
    throw 'Generated Windows Job Object assembly is invalid or exceeds its runtime bound.'
  }
  $assembly = [Reflection.Assembly]::Load($embedded)
  $type = $assembly.GetType('MiftahSecretJob', $true)
  if ($null -eq $type.GetMethod('Initialize', [Type[]]@()) -or $type.GetMethods().Where({ $_.Name -eq 'Run' }).Count -ne 2) {
    throw 'Generated Windows Job Object assembly does not expose the required helper contract.'
  }
  Write-Output 'Verified Windows helper source compilation and checked runtime artifact contract.'
} finally {
  if ([IO.Directory]::Exists($temporaryDirectory)) {
    [IO.Directory]::Delete($temporaryDirectory, $true)
  }
}
