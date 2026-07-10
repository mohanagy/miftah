import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { presetConfig } from "../config/presets.js";
import { generateConfigSchema } from "../config/generate-json-schema.js";
import { SecretResolver } from "../secrets/secret-resolver.js";
import { ProfileManager } from "../profiles/profile-manager.js";
import { UpstreamProcessManager } from "../upstream/upstream-process-manager.js";
import { MultiUpstreamProcessManager } from "../upstream/multi-upstream-process-manager.js";
import { MiftahServer } from "../mcp/server/miftah-server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redactSecrets } from "../secrets/redact.js";

interface CliArgs {
  command?: string;
  config?: string;
  profile?: string;
  output?: string;
  preset?: string;
  follow?: boolean;
  name?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const [first, ...rest] = argv;
  const result: CliArgs = {};
  if (first && !first.startsWith("-")) result.command = first;
  if (first === "init" && rest[0] && !rest[0].startsWith("-")) result.name = rest[0];
  const values = first?.startsWith("-") ? argv : rest;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--follow") {
      result.follow = true;
    } else if (value === "--config") {
      result.config = values[++index];
    } else if (value === "--profile") {
      result.profile = values[++index];
    } else if (value === "--output") {
      result.output = values[++index];
    } else if (value === "--preset") {
      result.preset = values[++index];
    } else if (value === "--name") {
      result.name = values[++index];
    }
  }
  return result;
}

async function createRuntime(configPath: string) {
  const config = await loadConfig(configPath);
  const resolver = new SecretResolver({
    envFiles: config.secrets?.envFiles,
    allowPlaintextSecrets: config.secrets?.allowPlaintextSecrets ?? config.security?.allowPlaintextSecrets
  });
  await resolver.load();
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => [
      name,
      {
        ...profile,
        env: profile.env ? resolver.resolveMap(profile.env) : profile.env,
        headers: profile.headers ? resolver.resolveMap(profile.headers) : profile.headers,
        upstreams: profile.upstreams
          ? Object.fromEntries(
              Object.entries(profile.upstreams).map(([upstreamName, override]) => [
                upstreamName,
                {
                  ...override,
                  env: override.env ? resolver.resolveMap(override.env) : override.env,
                  headers: override.headers ? resolver.resolveMap(override.headers) : override.headers
                }
              ])
            )
          : profile.upstreams
      }
    ])
  );
  const resolvedConfig = { ...config, profiles };
  const upstream = resolvedConfig.upstream
    ? {
        ...resolvedConfig.upstream,
        env: resolvedConfig.upstream.env ? resolver.resolveMap(resolvedConfig.upstream.env) : undefined,
        headers: resolvedConfig.upstream.headers ? resolver.resolveMap(resolvedConfig.upstream.headers) : undefined
      }
    : undefined;
  const manager = resolvedConfig.upstreams
    ? new MultiUpstreamProcessManager(resolvedConfig, {
        startupTimeoutMs: config.process?.startupTimeoutMs,
        restartOnCrash: config.process?.restartOnCrash,
        maxRestarts: config.process?.maxRestarts
      })
    : new UpstreamProcessManager(upstream!, profiles, {
    startupTimeoutMs: config.process?.startupTimeoutMs,
    restartOnCrash: config.process?.restartOnCrash,
    maxRestarts: config.process?.maxRestarts
      });
  const profileManager = new ProfileManager(resolvedConfig, resolvedConfig.security);
  return { config: resolvedConfig, manager, profileManager };
}

async function serve(configPath: string): Promise<void> {
  const runtime = await createRuntime(configPath);
  const server = new MiftahServer(runtime.config, runtime.profileManager, runtime.manager);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(transport);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const command = args.command ?? "serve";
  if (command === "schema") {
    process.stdout.write(`${JSON.stringify(generateConfigSchema(), null, 2)}\n`);
    return;
  }
  if (command === "init") {
    const name = args.name ?? args.config?.split("/").pop()?.replace(/\.json$/, "") ?? "miftah-wrapper";
    const output = resolve(args.output ?? `${name}.miftah.json`);
    const config = presetConfig(name, args.preset ?? "generic");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Created ${output}\n`);
    return;
  }
  if (!args.config) {
    throw new Error("Usage: miftah --config <file> | miftah <validate|doctor|list-tools|test-profile|logs> --config <file>");
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
    const runtime = await createRuntime(args.config);
    const commandName = runtime.config.upstream?.command;
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          config: runtime.config.name,
          defaultProfile: runtime.config.defaultProfile,
          upstreamCommand: commandName ?? null,
          profiles: runtime.profileManager.list().map((profile) => profile.name)
        },
        null,
        2
      )}\n`
    );
    await runtime.manager.close();
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
  process.exitCode = 1;
});

export { main, parseArgs };
