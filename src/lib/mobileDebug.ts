import { Capacitor, registerPlugin } from "@capacitor/core";

const debugConnection = registerPlugin<{ load(): Promise<{ url?: string }> }>("DebugConnection");

let debugUrl: string | undefined;

function validDebugAddress(url: URL) {
  return url.protocol === "ws:" && url.hostname === "10.0.2.2" && Boolean(url.port) && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
}

export async function loadMobileDebugConnection(): Promise<string | undefined> {
  if (Capacitor.getPlatform() !== "android") return undefined;
  const configuration = await debugConnection.load();

  if (!configuration.url) return undefined;
  const url = new URL(configuration.url);

  if (!validDebugAddress(url)) {
    throw new Error("Invalid emulator debug connection address.");
  }

  debugUrl = url.href;

  return debugUrl;
}

export function isMobileDebugConnection(url: string): boolean {
  return debugUrl !== undefined && url === debugUrl;
}
