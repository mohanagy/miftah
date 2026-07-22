param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repositoryRoot 'src/secrets/windows-secret-job.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not [IO.File]::Exists($compiler)) { throw 'Trusted .NET Framework C# compiler is unavailable.' }

$outputDirectory = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrEmpty($outputDirectory)) {
  [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}
if ([IO.File]::Exists($OutputPath)) {
  [IO.File]::Delete($OutputPath)
}

& $compiler /nologo /target:exe /main:MiftahSecretJob /platform:anycpu /optimize+ "/out:$OutputPath" $sourcePath
if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($OutputPath)) {
  throw 'Failed to compile the Windows Job Object executable.'
}

$assemblyBytes = [IO.File]::ReadAllBytes($OutputPath)
$compressed = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GzipStream]::new($compressed, [IO.Compression.CompressionLevel]::Optimal, $true)
try {
  $gzip.Write($assemblyBytes, 0, $assemblyBytes.Length)
} finally {
  $gzip.Dispose()
}
$encodedAssembly = [Convert]::ToBase64String($compressed.ToArray())
$compressed.Dispose()
$normalizedSource = [IO.File]::ReadAllText($sourcePath).Replace("`r`n", "`n").Replace("`r", "`n")
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $sourceHashBytes = $sha256.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($normalizedSource))
} finally {
  $sha256.Dispose()
}
$sourceHash = -join ($sourceHashBytes | ForEach-Object { $_.ToString('x2') })
Write-Output "MIFTAH_WINDOWS_SECRET_JOB_SOURCE_SHA256=$sourceHash"
Write-Output 'MIFTAH_WINDOWS_SECRET_JOB_EXECUTABLE_BEGIN'
Write-Output $encodedAssembly
Write-Output 'MIFTAH_WINDOWS_SECRET_JOB_EXECUTABLE_END'
