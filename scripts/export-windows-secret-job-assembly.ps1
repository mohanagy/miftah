param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$runtimeSourcePath = Join-Path $repositoryRoot 'src/secrets/windows-secret-command.ts'
$runtimeSource = [IO.File]::ReadAllText($runtimeSourcePath)
$pattern = [regex]::new(
  'const windowsJobHelper = String\.raw`[\s\S]*?\$source = @''\r?\n([\s\S]*?)\r?\n''@\r?\n {2}Add-Type -TypeDefinition \$source',
  [Text.RegularExpressions.RegexOptions]::CultureInvariant
)
$match = $pattern.Match($runtimeSource)
if (-not $match.Success) {
  throw 'Embedded Windows Job Object C# source is unavailable.'
}

$outputDirectory = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrEmpty($outputDirectory)) {
  [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}
if ([IO.File]::Exists($OutputPath)) {
  [IO.File]::Delete($OutputPath)
}

Add-Type -TypeDefinition $match.Groups[1].Value -OutputAssembly $OutputPath -OutputType Library
$encodedAssembly = [Convert]::ToBase64String([IO.File]::ReadAllBytes($OutputPath))
Write-Output 'MIFTAH_WINDOWS_SECRET_JOB_ASSEMBLY_BEGIN'
Write-Output $encodedAssembly
Write-Output 'MIFTAH_WINDOWS_SECRET_JOB_ASSEMBLY_END'
