function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function quoteForPowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Quotes a literal argument for the shell named by Miftah on the current platform. */
export function quoteShellArgument(value: string): string {
  return process.platform === "win32" ? quoteForPowerShell(value) : quoteForPosixShell(value);
}

/** Windows command instructions explicitly identify PowerShell, whose quoting rules they use. */
export function commandInstruction(action: string, command: string): string {
  return `${action}${process.platform === "win32" ? " in PowerShell" : ""}: ${command}`;
}
