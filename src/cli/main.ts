import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { presetConfig } from "../config/presets.js";
import { generateConfigSchema } from "../config/generate-json-schema.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redactSecrets } from "../secrets/redact.js";
import { createRuntime } from "./create-runtime.js";
import { createMiftahRuntime } from "../runtime/create-miftah-runtime.js";
import { MIFTAH_VERSION } from "../version.js";
import { runDoctor } from "./doctor.js";
import { formatDoctorReport } from "./doctor-report.js";
import { CliUsageError, parseCli, renderCommandHelp, renderRootHelp } from "./parse.js";
import { exitCodeForError } from "./exit-codes.js";

async function serve(configPath: string): Promise<void> {
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
    const name = args.name ?? "miftah-wrapper";
    const output = resolve(args.output ?? `${name}.miftah.json`);
    const config = presetConfig(name, args.preset ?? "generic");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Created ${output}\n`);
    return;
  }
  if (!args.config) {
    throw new CliUsageError(
      `Command '${command}' requires '--config <file>'. Use 'miftah ${command} --help' for usage.`
    );
  }
  if (command === "serve") {
    await serve(args.config);
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
    const config = await loadConfig(args.config);
    const path = config.audit?.path;
    if (!path) throw new Error("Audit logging is not configured.");
    process.stdout.write(await readFile(path, "utf8").catch((error) => redactSecrets(String(error))));
    return;
  }
  throw new Error(`Unknown command '${command}'`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = exitCodeForError(error);
});

export { main };
