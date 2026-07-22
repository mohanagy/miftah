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
  & $compiler /nologo /target:library /platform:anycpu /optimize+ /deterministic+ "/out:$compiledPath" $sourcePath
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($compiledPath)) {
    throw 'Failed to compile the Windows Job Object helper.'
  }

  $generatedSource = [IO.File]::ReadAllText($generatedPath)
  $match = [regex]::Match(
    $generatedSource,
    'export const encodedWindowsSecretJobAssembly = "([A-Za-z0-9+/=]+)";',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $match.Success) { throw 'Generated Windows Job Object assembly is unavailable.' }

  $compressedInput = [IO.MemoryStream]::new([Convert]::FromBase64String($match.Groups[1].Value), $false)
  $gzip = [IO.Compression.GzipStream]::new($compressedInput, [IO.Compression.CompressionMode]::Decompress, $false)
  $embeddedOutput = [IO.MemoryStream]::new()
  try {
    $gzip.CopyTo($embeddedOutput)
  } finally {
    $gzip.Dispose()
    $compressedInput.Dispose()
  }

  $compiled = [IO.File]::ReadAllBytes($compiledPath)
  $embedded = $embeddedOutput.ToArray()
  $embeddedOutput.Dispose()
  if ([Convert]::ToBase64String($compiled) -cne [Convert]::ToBase64String($embedded)) {
    throw 'Generated Windows Job Object assembly does not match its canonical C# source.'
  }
  Write-Output 'Verified precompiled Windows secret helper.'
} finally {
  if ([IO.Directory]::Exists($temporaryDirectory)) {
    [IO.Directory]::Delete($temporaryDirectory, $true)
  }
}
