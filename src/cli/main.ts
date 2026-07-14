import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load-config.js";
import { generateConfigSchema } from "../config/generate-json-schema.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redactSecrets } from "../secrets/redact.js";
import { createRuntime } from "./create-runtime.js";
import { createMiftahRuntime } from "../runtime/create-miftah-runtime.js";
import { startMiftahHttpServer } from "../http/miftah-http-server.js";
import { MIFTAH_VERSION } from "../version.js";
import { runDoctor } from "./doctor.js";
import { formatDoctorReport } from "./doctor-report.js";
import { CliUsageError, parseCli, renderCommandHelp, renderRootHelp } from "./parse.js";
import { exitCodeForError } from "./exit-codes.js";
import { runLogsCommand } from "./logs.js";
import { runInitCommand } from "./init.js";
import { runAuditExportCommand } from "./audit-export.js";
import { formatAuditVerifyReport, runAuditVerifyCommand } from "./audit-verify.js";
import { runMigrateConfigCommand } from "./migrate-config.js";

async function serve(configPath: string, transportKind = "stdio"): Promise<void> {
  if (transportKind === "http") {
    const server = await startMiftahHttpServer(configPath);
    process.stdout.write(`Miftah HTTP server listening on ${server.url.toString()}\n`);
    const shutdown = (): void => {
      void server.close().catch(() => {
        process.stderr.write("Miftah HTTP server shutdown failed.\n");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  const runtime = await createMiftahRuntime(configPath);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await runtime.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runtime.connect(transport);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const invocation = parseCli(argv);
  if (invocation.kind === "help") {
    process.stdout.write(`${invocation.command ? renderCommandHelp(invocation.command) : renderRootHelp()}\n`);
    return;
  }
  if (invocation.kind === "version") {
    process.stdout.write(`${MIFTAH_VERSION}\n`);
    return;
  }
  const { command, options: args } = invocation;
  if (command === "schema") {
    process.stdout.write(`${JSON.stringify(generateConfigSchema(), null, 2)}\n`);
    return;
  }
  if (command === "init") {
    await runInitCommand(args, {
      input: process.stdin,
      output: process.stdout,
      cwd: process.cwd(),
      launcher: {
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), "serve"]
      }
    });
    return;
  }
  if (!args.config) {
    throw new CliUsageError(
      `Command '${command}' requires '--config <file>'. Use 'miftah ${command} --help' for usage.`
    );
  }
  if (command === "migrate-config") {
    const report = await runMigrateConfigCommand({ configPath: args.config, write: args.write === true });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === "serve") {
    await serve(args.config, args.transport);
    return;
  }
  if (command === "validate") {
    const config = await loadConfig(args.config);
    process.stdout.write(`${JSON.stringify({ ok: true, name: config.name, profiles: Object.keys(config.profiles) }, null, 2)}\n`);
    return;
  }
  if (command === "doctor") {
    const report = await runDoctor(args.config);
    process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === "list-tools" || command === "test-profile") {
    const runtime = await createRuntime(args.config);
    const profile = args.profile ?? runtime.config.defaultProfile;
    if (command === "list-tools") {
      process.stdout.write(`${JSON.stringify(await runtime.manager.listTools(profile), null, 2)}\n`);
    } else {
      const session = await runtime.manager.get(profile);
      await session.listTools();
      process.stdout.write(`${JSON.stringify({ ok: true, profile }, null, 2)}\n`);
    }
    await runtime.manager.close();
    return;
  }
  if (command === "logs") {
    await runLogsCommand({ configPath: args.config, follow: args.follow === true });
    return;
  }
  if (command === "audit-export") {
    if (!args.output) {
      throw new CliUsageError(
        "Command 'audit-export' requires '--output <file>'. Use 'miftah audit-export --help' for usage."
      );
    }
    await runAuditExportCommand({
      configPath: args.config,
      outputPath: args.output,
      includeArguments: args.includeArguments === true
    });
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  if (command === "audit-verify") {
    const report = await runAuditVerifyCommand({ configPath: args.config });
    process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : formatAuditVerifyReport(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  throw new Error(`Unknown command '${command}'`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = exitCodeForError(error);
});

export { main };
