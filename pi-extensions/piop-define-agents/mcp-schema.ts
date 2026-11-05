import { array, boolean, enum as enumeration, number, object, record, string, type RefinementCtx, type ZodType } from "zod";

const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

const httpUrl = string().refine(value => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol), "Expected an HTTP or HTTPS URL");

const secureUrl = (value: string) => URL.canParse(value) && (new URL(value).protocol === "https:" || new URL(value).protocol === "http:" && loopback(new URL(value)));

const oauth = object({
  clientId: string().optional(), clientSecret: string().optional(), scope: string().optional(),
  clientName: string().refine(value => Boolean(value.trim()), "Client name must not be empty").optional(),
  callbackPort: number().int().min(1).max(65535).optional(),
  clientRegistration: enumeration(["auto", "dcr", "cimd"]).optional(),
  callbackUrl: string().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);

    return url.protocol === "http:" && loopback(url) && !url.search && !url.hash;
  }, "Callback URL must use HTTP on a loopback host without a query or fragment").optional(),
  authServerMetadataUrl: string().refine(secureUrl, "Metadata URL must use HTTPS or HTTP on a loopback host").optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.callbackUrl || !URL.canParse(value.callbackUrl)) return;
  const port = new URL(value.callbackUrl).port;

  if (port && value.callbackPort !== undefined && Number(port) !== value.callbackPort) ctx.addIssue({ code: "custom", path: ["callbackPort"], message: "Callback URL and port must agree" });
});

const serverFields = object({
  type: enumeration(["stdio", "http", "streamable-http"]).optional(),
  command: string().optional(), args: array(string()).optional(), env: record(string(), string()).optional(), cwd: string().optional(),
  url: httpUrl.optional(), headers: record(string(), string()).optional(),
  enabled: boolean().optional(), timeout: number().positive().optional(), description: string().optional(),
  oauth: oauth.optional(), auth: object({ provider: string().min(1) }).passthrough().optional(),
  piopInjectAgentId: boolean().optional(),
}).passthrough();

const checkTransport = (value: { type?: string; command?: string; url?: string; auth?: object }, ctx: RefinementCtx) => {
  const http = value.url !== undefined && value.type !== "stdio";

  if (!http && !(value.command?.trim() && (value.type === undefined || value.type === "stdio"))) ctx.addIssue({ code: "custom", message: "Transport requires a command for stdio or a URL for HTTP" });

  if (http && value.auth && !secureUrl(String(value.url))) ctx.addIssue({ code: "custom", path: ["url"], message: "Provider authentication requires HTTPS or HTTP on a loopback host" });
};

export const mcpServerSchema = serverFields.superRefine((value, ctx) => {
  for (const field of ["exposure", "toolExposure"]) {
    if (field in value) ctx.addIssue({ code: "custom", path: [field], message: "The agent's Codemode switch decides how MCP tools are reached. Remove " + field });
  }

  checkTransport(value, ctx);
});

export const skillMcpServerSchema = serverFields.extend({ exposure: enumeration(["deferred", "codemode", "direct"]) }).superRefine((value, ctx) => {
  if ("toolExposure" in value) ctx.addIssue({ code: "custom", path: ["toolExposure"], message: "Skill MCP servers set one exposure for all tools. Remove toolExposure" });

  checkTransport(value, ctx);
});

const servers = <T extends ZodType>(server: T) => record(string().regex(/^[a-zA-Z0-9_-]+$/, "Use letters, digits, underscores or hyphens for server names"), server)
  .refine(value => new Set(Object.keys(value).map(name => name.replaceAll("-", "_"))).size === Object.keys(value).length, "MCP server names must not differ only by hyphens and underscores");

export const mcpServersSchema = servers(mcpServerSchema);

export const skillMcpServersSchema = servers(skillMcpServerSchema);
