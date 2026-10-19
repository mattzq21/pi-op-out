import { AsyncLocalStorage } from "node:async_hooks";

const identities = new AsyncLocalStorage();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function request(body) {
  const url = process.env.PI_DESKTOP_BROKER_URL;
  const token = process.env.PI_DESKTOP_BROKER_TOKEN;
  if (!url || !token) throw new Error("Session identity requires the Piop daemon");
  const response = await fetch(`${url}/session-identity`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error ?? `Session identity request failed: ${response.status}`);
  return result.data;
}

export async function reserveSessionIds(count) {
  const result = await request({ action: "reserve", count });
  if (!Array.isArray(result?.sessionIds) || result.sessionIds.length !== count
    || result.sessionIds.some(id => typeof id !== "string" || !uuid.test(id))
    || new Set(result.sessionIds).size !== count) throw new Error("Daemon returned invalid session identities");
  return result.sessionIds;
}

export async function reserveSessionId() { return (await reserveSessionIds(1))[0]; }

export function takeSessionId() {
  const id = identities.getStore()?.shift();
  if (!id) throw new Error("Session identity was not reserved by the daemon");
  return id;
}

export async function withSessionIds(operation) {
  const reserved = await reserveSessionIds(2);
  try { return await identities.run(reserved, operation); }
  finally { if (reserved.length) await request({ action: "release", sessionIds: reserved }); }
}
