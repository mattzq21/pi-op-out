import { AsyncLocalStorage } from "node:async_hooks";

const identities = new AsyncLocalStorage();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function request(body) {
  const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value;
  if (!send) throw new Error("Session identity requires the Piop daemon");
  const answer = await send("broker", { path: "/session-identity", body });
  if (typeof answer?.error === "string") throw new Error(answer.error);
  return answer?.data;
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
