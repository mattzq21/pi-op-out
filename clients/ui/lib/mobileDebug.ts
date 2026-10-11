import { Capacitor, registerPlugin } from "@capacitor/core";

const debugConnection = registerPlugin<{ load(): Promise<{ url?: string; hostUrl?: string; token?: string }> }>("DebugConnection");

let debugUrl: string | undefined;
let debugToken: string | undefined;

function validDebugAddress(url: URL) {
  return url.protocol === "ws:" && ["10.0.2.2", "127.0.0.1"].includes(url.hostname) && Boolean(url.port) && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
}

export async function loadMobileDebugConnection(): Promise<string | undefined> {
  if (Capacitor.getPlatform() !== "android") return undefined;
  const configuration = await debugConnection.load();

  if (configuration.hostUrl) {
    const host = new URL(configuration.hostUrl);

    if (host.protocol !== "wss:") throw new Error("Use a secure wss:// address for your Piop host.");

    return host.href;
  }

  if (!configuration.url) return undefined;
  const url = new URL(configuration.url);

  if (!validDebugAddress(url)) {
    throw new Error("Invalid Android debug connection address.");
  }

  if (typeof configuration.token !== "string" || configuration.token.length < 32) throw new Error("Missing Android debug connection token.");
  debugToken = configuration.token;
  debugUrl = url.href;

  return debugUrl;
}

export function isMobileDebugConnection(url: string): boolean {
  return debugUrl !== undefined && url === debugUrl;
}

export function mobileDebugToken(url: string): string | undefined { return isMobileDebugConnection(url) ? debugToken : undefined; }
