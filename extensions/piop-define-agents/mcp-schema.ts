import { z } from "zod";

const exposure = z.enum(["direct", "deferred", "codemode", "codemode-deferred", "hidden"]);

const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

const httpUrl = z.string().refine(value => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol), "Expected an HTTP or HTTPS URL");

const secureUrl = (value: string) => URL.canParse(value) && (new URL(value).protocol === "https:" || new URL(value).protocol === "http:" && loopback(new URL(value)));

const oauth = z.object({
  clientId: z.string().optional(), clientSecret: z.string().optional(), scope: z.string().optional(),
  clientName: z.string().refine(value => Boolean(value.trim()), "Client name must not be empty").optional(),
  callbackPort: z.number().int().min(1).max(65535).optional(),
  callbackUrl: z.string().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);

    return url.protocol === "http:" && loopback(url) && !url.search && !url.hash;
  }, "Callback URL must use HTTP on a loopback host without a query or fragment").optional(),
  authServerMetadataUrl: z.string().refine(secureUrl, "Metadata URL must use HTTPS or HTTP on a loopback host").optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.callbackUrl || !URL.canParse(value.callbackUrl)) return;
  const port = new URL(value.callbackUrl).port;

  if (port && value.callbackPort !== undefined && Number(port) !== value.callbackPort) ctx.addIssue({ code: "custom", path: ["callbackPort"], message: "Callback URL and port must agree" });
});

export const mcpServerSchema = z.object({
  type: z.enum(["stdio", "http", "streamable-http"]).optional(),
  command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional(),
  url: httpUrl.optional(), headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(), timeout: z.number().positive().optional(), description: z.string().optional(),
  exposure: exposure.optional(), toolExposure: z.record(z.string(), exposure).optional(),
  oauth: oauth.optional(), auth: z.object({ provider: z.string().min(1) }).passthrough().optional(),
  piopInjectAgentId: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const http = value.url !== undefined && value.type !== "stdio";

  if (!http && !(value.command?.trim() && (value.type === undefined || value.type === "stdio"))) ctx.addIssue({ code: "custom", message: "Transport requires a command for stdio or a URL for HTTP" });

  if (http && value.auth && !secureUrl(String(value.url))) ctx.addIssue({ code: "custom", path: ["url"], message: "Provider authentication requires HTTPS or HTTP on a loopback host" });
});

export const mcpServersSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/, "Use letters, digits, underscores or hyphens for server names"), mcpServerSchema)
  .refine(value => new Set(Object.keys(value).map(name => name.replaceAll("-", "_"))).size === Object.keys(value).length, "MCP server names must not differ only by hyphens and underscores");
