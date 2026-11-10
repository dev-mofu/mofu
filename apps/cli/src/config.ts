import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_MODEL } from "@mofu/core";

const ConfigSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
});
export type MofuConfig = z.infer<typeof ConfigSchema>;

/** ~/.mofu, overridable with MOFU_HOME (used by tests). */
export function mofuHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOFU_HOME || path.join(os.homedir(), ".mofu");
}

export const configPath = (env?: NodeJS.ProcessEnv) => path.join(mofuHome(env), "config.json");
export const memoryPath = (env?: NodeJS.ProcessEnv) => path.join(mofuHome(env), "memory.md");

export async function loadConfig(env?: NodeJS.ProcessEnv): Promise<MofuConfig> {
  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(await readFile(configPath(env), "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Merges and saves config. On macOS/Linux the file is made readable by the
 * current user only (0600). Windows ignores these mode bits; there the file is
 * protected by the user profile's folder permissions.
 */
export async function saveConfig(update: MofuConfig, env?: NodeJS.ProcessEnv): Promise<void> {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = { ...(await loadConfig(env)), ...update };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Env var wins over the saved key, so CI and one-off overrides work. */
export function resolveApiKey(env: NodeJS.ProcessEnv, config: MofuConfig): string | undefined {
  return nonEmpty(env.OPENROUTER_API_KEY) ?? nonEmpty(config.apiKey);
}

/** --model flag, then MOFU_MODEL, then the config file, then the default. */
export function resolveModel(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: MofuConfig,
): string {
  return nonEmpty(flag) ?? nonEmpty(env.MOFU_MODEL) ?? nonEmpty(config.model) ?? DEFAULT_MODEL;
}
