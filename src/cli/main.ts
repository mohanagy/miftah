import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { runSetupCommand } from "./setup.js";
import { runAuditExportCommand } from "./audit-export.js";
import { formatAuditVerifyReport, runAuditVerifyCommand } from "./audit-verify.js";
import { runMigrateConfigCommand } from "./migrate-config.js";
import { runConnectionAddCommand } from "../oauth/connection-application-service.js";
import { OAuthConnectionCommandService } from "../oauth/connection-command-service.js";
import { CLIENT_NAMES, renderClientSnippets, type ClientSelection } from "./client-snippets.js";
import { resolvePath } from "../config/path-resolve.js";
import { startConsoleServer } from "../console/console-server.js";
import { openSystemBrowser } from "../console/open-browser.js";
import { ConsoleDashboardApplicationService } from "../console/console-dashboard-application-service.js";

function oauthSelector(args: { readonly connection?: string; readonly profile?: string; readonly upstream?: string }) {
  return {
    ...(args.connection === undefined ? {} : { connectionRef: args.connection }),
    ...(args.profile === undefined ? {} : { profile: args.profile }),
    ...(args.upstream === undefined ? {} : { upstream: args.upstream })
  };
}

function requireOption(command: string, name: string, value: string | undefined): string {
  if (value === undefined) {
    throw new CliUsageError(
      `Command '${command}' requires '--${name} <value>'. Use 'miftah ${command} --help' for usage.`
    );
  }
  return value;
}

function clientSelection(value: string): ClientSelection {
  if (value === "all" || (CLIENT_NAMES as readonly string[]).includes(value)) return value as ClientSelection;
  throw new CliUsageError("Option '--client' must name a supported MCP client or 'all'.");
}

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

function consolePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new CliUsageError("Option '--port' must be an integer from 1 to 65535.");
  }
  return Number(value);
}

function registerConsoleServerLifecycle(server: Awaited<ReturnType<typeof startConsoleServer>>): void {
  const shutdown = (): void => {
    void server.close().catch(() => {
      process.stderr.write("Miftah Console shutdown failed.\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {
      process.stdout.write(`Replacement one-time bootstrap code: ${server.rotateCredential()}\n`);
    });
  }
}

async function consoleServe(configPath: string, port: string | undefined): Promise<void> {
  const server = await startConsoleServer(configPath, {
    port: consolePort(port),
    launcher: { command: process.execPath, args: [fileURLToPath(import.meta.url), "serve"] }
  });
  process.stdout.write(
    [
      `Miftah Console control API listening on ${server.url.toString()}`,
      `One-time bootstrap code: ${server.bootstrapCredential}`,
      "Enter this code only in the local Miftah Console. It expires after first use or shutdown."
    ].join("\n") + "\n"
  );
  registerConsoleServerLifecycle(server);
}

function defaultDashboardConfigPath(): string {
  return join(homedir(), ".config", "miftah", "miftah.json");
}

async function dashboardServe(
  configPath: string,
  port: string | undefined,
  openBrowser: boolean,
  discoverExistingConfigurations: boolean
): Promise<void> {
  const launcher = { command: process.execPath, args: [fileURLToPath(import.meta.url), "serve"] };
  const application = discoverExistingConfigurations
    ? new ConsoleDashboardApplicationService({
        defaultConfigPath: configPath,
        configDirectory: dirname(resolvePath(configPath)),
        launcher
      })
    : undefined;
  const server = await startConsoleServer(configPath, {
    port: consolePort(port),
    allowMissingConfig: true,
    ...(discoverExistingConfigurations ? { deferConfigValidation: true } : {}),
    launcher,
    ...(application === undefined ? {} : { application })
  });
  process.stdout.write(
    [
      `Miftah Console listening on ${server.url.toString()}`,
      ...(discoverExistingConfigurations
        ? [
            `Configuration catalog: ${dirname(resolvePath(configPath))} (direct safe JSON files only)`,
            `First-run configuration location: ${resolvePath(configPath)}`
          ]
        : [`Configuration: ${resolvePath(configPath)}`]),
      `One-time bootstrap code: ${server.bootstrapCredential}`,
      "Enter this code only in the local Miftah Console. It expires after first use or shutdown."
    ].join("\n") + "\n"
  );
  if (openBrowser && !(await openSystemBrowser(server.url))) {
    process.stderr.write(`Miftah could not open the system browser. Open ${server.url.toString()} manually.\n`);
  }
  registerConsoleServerLifecycle(server);
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
  if (command === "setup") {
    await runSetupCommand(args, {
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
  if (command === "dashboard") {
    await dashboardServe(
      args.config ?? defaultDashboardConfigPath(),
      args.port,
      args.noOpen !== true,
      args.config === undefined
    );
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
  if (command === "connection add") {
    const report = await runConnectionAddCommand({
      configPath: args.config,
      connectionRef: args.connection,
      profile: requireOption(command, "profile", args.profile),
      upstream: args.upstream,
      issuer: requireOption(command, "issuer", args.issuer),
      clientRegistration: requireOption(command, "client-registration", args.clientRegistration),
      scopes: args.scopes ?? [],
      write: args.write === true
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === "connection list") {
    const service = new OAuthConnectionCommandService(args.config);
    const connections = await service.list();
    const config = await loadConfig(args.config);
    const snippets = args.client === undefined
      ? undefined
      : renderClientSnippets(clientSelection(args.client), {
          serverName: config.name,
          configPath: resolvePath(args.config),
          launcher: { command: process.execPath, args: [fileURLToPath(import.meta.url), "serve"] }
        });
    process.stdout.write(`${JSON.stringify({ connections, ...(snippets === undefined ? {} : { snippets }) }, null, 2)}\n`);
    return;
  }
  if (command === "connection status") {
    const service = new OAuthConnectionCommandService(args.config);
    process.stdout.write(`${JSON.stringify(await service.status(oauthSelector(args)), null, 2)}\n`);
    return;
  }
  if (command === "connection test") {
    const service = new OAuthConnectionCommandService(args.config);
    process.stdout.write(`${JSON.stringify(await service.test(oauthSelector(args)), null, 2)}\n`);
    return;
  }
  if (command === "auth connect" || command === "auth reauth") {
    const service = new OAuthConnectionCommandService(args.config);
    const result = command === "auth connect"
      ? await service.connect(oauthSelector(args), { nonInteractive: args.nonInteractive === true })
      : await service.reauth(oauthSelector(args), { nonInteractive: args.nonInteractive === true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "auth disconnect") {
    const service = new OAuthConnectionCommandService(args.config);
    process.stdout.write(`${JSON.stringify(await service.disconnect(oauthSelector(args)), null, 2)}\n`);
    return;
  }
  if (command === "serve") {
    await serve(args.config, args.transport);
    return;
  }
  if (command === "console") {
    await consoleServe(args.config, args.port);
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
