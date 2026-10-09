import { z } from "zod";
import { readText } from "../../../daemon/resources/session-broker/app-settings.cjs";
import { dirname, join, resolve, sep } from "node:path";
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
  provider: z.string().trim().toLowerCase().refine(provider => SUPPORTED_PROVIDER_SET.has(provider)),
  model: z.string().trim().min(1),
  serviceTier: z.string().trim().min(1).catch(DEFAULT_SERVICE_TIER),
});

const targetsSchema = z.array(fastTargetSchema.optional().catch(undefined)).transform(items => items.flatMap(item => item ? [item] : []));

const configSchema = z.object({ enabled: z.boolean().optional().catch(undefined), targets: targetsSchema.optional().catch(undefined) });

export function normalizeTargets(rawTargets: FastTarget[] | undefined): FastTarget[] | undefined {
  const parsed = targetsSchema.safeParse(rawTargets);

  if (!parsed.success) return undefined;
  const normalized: FastTarget[] = [];
  const seen = new Set<string>();

  for (const target of parsed.data) {
    const key = target.provider + "\u0000" + target.model;

    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(target);
  }

  return normalized;
}

export function normalizeConfig(raw: Partial<FastModeConfig> | null | undefined, fallback: FastModeConfig = DEFAULT_CONFIG): FastModeConfig {
  const safeFallback = cloneConfig(fallback);
  const parsed = configSchema.safeParse(raw);

  if (!parsed.success) return safeFallback;

  return { enabled: parsed.data.enabled ?? safeFallback.enabled, targets: normalizeTargets(parsed.data.targets) ?? safeFallback.targets };
}

export function parseConfigJson(
  json: string,
  fallback: FastModeConfig = DEFAULT_CONFIG,
): FastModeConfig {
  try {
    return normalizeConfig(JSON.parse(json), fallback);
  } catch {
    return cloneConfig(fallback);
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

  return json === undefined ? cloneConfig(fallback) : parseConfigJson(json, fallback);
}

function readConfigText(path: string): string | undefined {
  const legacy = join(dirname(dirname(path)), "pi-openai-fast-mode-piop", "config.json");

  return readText(path, legacy, (value: Partial<FastModeConfig>) => configSchema.safeParse(value).success);
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
