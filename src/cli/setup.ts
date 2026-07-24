import { runInitCommand, type InitCommandContext, type InitCommandOptions } from "./init.js";

/**
 * Starts the human-first setup journey while retaining `init` for scripts and
 * existing automation. Both entry points deliberately use the same planner,
 * validation, config writer, and client-handoff implementation.
 */
export async function runSetupCommand(options: InitCommandOptions, context: InitCommandContext): Promise<void> {
  await runInitCommand({ ...options, interactive: true }, context);
}
