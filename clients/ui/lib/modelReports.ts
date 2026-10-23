import type { Model } from "../types";

type Report = (hostId: string, ids: string[]) => void | Promise<void>;
const reports = new Set<Report>();
const connections = new Set<(hostId: string) => void>();
const sessions = new Set<{ hostId: () => string; refresh: () => Promise<void> }>();

export function observeModelReports(listener: Report) { reports.add(listener); return () => { reports.delete(listener); }; }
export async function reportModels(hostId: string, models: Model[]) { if (models.length) await Promise.all([...reports].map(listener => listener(hostId, models.map(model => `${model.provider}/${model.id}`)))); }
export function observeModelConnections(listener: (hostId: string) => void) { connections.add(listener); return () => { connections.delete(listener); }; }
export function hostModelConnected(hostId: string) { for (const listener of connections) listener(hostId); }
export function registerModelSession(hostId: () => string, refresh: () => Promise<void>) { const session = { hostId, refresh }; sessions.add(session); return () => { sessions.delete(session); }; }
export async function refreshHostModels(hostId: string) {
  const results = await Promise.allSettled([...sessions].filter(session => session.hostId() === hostId).map(session => session.refresh()));
  const errors = results.filter(result => result.status === "rejected");

  if (errors.length) throw new Error(errors.map(result => String(result.reason)).join("\n"));
}
