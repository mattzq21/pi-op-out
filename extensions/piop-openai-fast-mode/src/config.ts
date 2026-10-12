import { z } from "zod";
import { readText } from "../../../daemon/resources/session-broker/app-settings.cjs";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SERVICE_TIER,
  SUPPORTED_PROVIDERS,
  type FastModeConfig,
  type FastTarget,
  type ResolvedConfigPath,
} from "./types";

export const DEFAULT_CONFIG: FastModeConfig = {
  enabled: false,
  targets: [],
};

const SUPPORTED_PROVIDER_SET = new Set<string>(SUPPORTED_PROVIDERS);

function cloneTarget(target: FastTarget): FastTarget {
  return {
    provider: target.provider,
    model: target.model,
    serviceTier: target.serviceTier ?? DEFAULT_SERVICE_TIER,
  };
}

export function cloneConfig(
  config: FastModeConfig = DEFAULT_CONFIG,
): FastModeConfig {
  return {
    enabled: config.enabled,
    targets: config.targets.map(cloneTarget),
  };
}

export function syncSupportedTargets(config: FastModeConfig, targets: FastTarget[] = []): FastModeConfig {
  return {
    enabled: config.enabled,
    targets: targets.map(cloneTarget),
  };
}

const fastTargetSchema = z.object({
  provider: z.string().trim().toLowerCase().refine(provider => SUPPORTED_PROVIDER_SET.has(provider), { message: `provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}` }),
  model: z.string().trim().min(1),
  serviceTier: z.string().trim().min(1).optional().transform(tier => tier ?? DEFAULT_SERVICE_TIER),
});

const targetsSchema = z.array(fastTargetSchema);

const configSchema = z.object({ enabled: z.boolean().optional(), targets: targetsSchema.optional() });

function uniqueTargets(targets: FastTarget[]): FastTarget[] {
  const normalized: FastTarget[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const key = target.provider + "\u0000" + target.model;

    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(target);
  }

  return normalized;
}

export function normalizeConfig(raw: unknown, fallback: FastModeConfig = DEFAULT_CONFIG): FastModeConfig {
  const safeFallback = cloneConfig(fallback);
  const parsed = configSchema.safeParse(raw);

  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));

  return { enabled: parsed.data.enabled ?? safeFallback.enabled, targets: parsed.data.targets ? uniqueTargets(parsed.data.targets) : safeFallback.targets };
}

export function parseConfigJson(
  json: string,
  path: string,
  fallback: FastModeConfig = DEFAULT_CONFIG,
): FastModeConfig {
  try {
    return normalizeConfig(JSON.parse(json), fallback);
  } catch (error) {
    throw new Error(`Invalid fast mode config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getUserConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", "piop-openai-fast-mode", "config.json");
}

export function getProjectConfigPath(cwd: string): string {
  return join(resolve(cwd), ".pi", "piop-openai-fast-mode", "config.json");
}

export function isProjectLocalExtension(
  extensionDir: string | undefined,
  cwd: string,
): boolean {
  if (!extensionDir) return false;

  const projectPiDir = resolve(cwd, ".pi");
  const resolvedExtensionDir = resolve(extensionDir);

  return (
    resolvedExtensionDir === projectPiDir ||
    resolvedExtensionDir.startsWith(
      projectPiDir.endsWith(sep) ? projectPiDir : `${projectPiDir}${sep}`,
    )
  );
}

export type SelectConfigPathOptions = {
  cwd: string;
  extensionDir?: string;
  agentDir?: string;
  exists?: (path: string) => boolean;
};

export function selectConfigPath({
  cwd,
  extensionDir,
  agentDir,
  exists = path => readConfigText(path) !== undefined,
}: SelectConfigPathOptions): ResolvedConfigPath {
  const projectPath = getProjectConfigPath(cwd);

  if (exists(projectPath)) {
    return { scope: "project", path: projectPath };
  }

  if (isProjectLocalExtension(extensionDir, cwd)) {
    return { scope: "project", path: projectPath };
  }

  return { scope: "user", path: getUserConfigPath(agentDir) };
}

export type LoadConfigOptions = Omit<SelectConfigPathOptions, "exists"> & {
  fallback?: FastModeConfig;
};

export type LoadedConfig = ResolvedConfigPath & {
  config: FastModeConfig;
};

export async function loadConfigFromPath(
  configPath: string,
  fallback: FastModeConfig = DEFAULT_CONFIG,
): Promise<FastModeConfig> {
  const json = readConfigText(configPath);

  return json === undefined ? cloneConfig(fallback) : parseConfigJson(json, configPath, fallback);
}

function readConfigText(path: string): string | undefined {

  return readText(path);
}

export async function loadConfigForScope(
  options: LoadConfigOptions,
): Promise<LoadedConfig> {
  const selected = selectConfigPath(options);

  const config = await loadConfigFromPath(
    selected.path,
    options.fallback ?? DEFAULT_CONFIG,
  );

  return { ...selected, config };
}
