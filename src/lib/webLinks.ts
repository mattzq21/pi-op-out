const webHost = /^(?:(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+(?:com|org|net|edu|gov|mil|int|io|dev|app|ai|co|info|biz|me|cloud|tech|xyz|online|site|test|example|local)|localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:[/?#]|$)/i;

export function webUrl(value: string): string | undefined {
  const href = value.trim();
  const candidate = href.startsWith("//") ? `https:${href}` : /^(?:www\.)[^\s/]+(?:[/?#]|$)/i.test(href) || webHost.test(href) ? `https://${href}` : href;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}
