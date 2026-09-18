import { useEffect, useRef, useState } from "react";
import { invoke } from "./platform";

export interface ProviderAccount {
  id: string;
  name: string;
  configured: boolean;
  source?: string;
  storedType?: "oauth" | "api_key";
  methods: Array<{ type: "oauth" | "api_key"; name: string; interactive: boolean }>;
}
export interface AuthNotice {
  type: "info" | "progress" | "auth_url" | "device_code";
  message?: string;
  url?: string;
  userCode?: string;
  links?: Array<{ url?: string; label?: string }>;
}
export interface AuthFlow {
  flowId: string;
  providerId: string;
  status: "pending" | "complete" | "cancelled" | "failed";
  notices: AuthNotice[];
  error?: string;
  prompt?: { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> };
}
interface Listing { providers: ProviderAccount[] }
const call = <T>(hostId: string, request: Record<string, unknown>) => invoke<T>("provider_auth", { hostId, request });
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const cancelFlow = (hostId: string, flowId: string) => call<AuthFlow>(hostId, { action: "cancel", flowId });

export function useProviderAuth(hostId: string) {
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [flow, setFlow] = useState<AuthFlow>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const active = useRef<{ hostId: string; flowId: string } | undefined>(undefined);
  const requestPending = useRef(false);

  useEffect(() => {
    generation.current++;
    setProviders([]); setFlow(undefined); setLoading(true); setWorking(false); setError(undefined);
    requestPending.current = false;
    return () => {
      generation.current++;
      const previous = active.current;
      active.current = undefined;
      if (previous) void cancelFlow(previous.hostId, previous.flowId).catch(() => undefined);
    };
  }, [hostId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void call<Listing>(hostId, { action: "list" }).then((listing) => { if (!cancelled) setProviders(listing.providers); })
      .catch((reason) => { if (!cancelled) setError(message(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hostId, revision]);

  const receive = (next: AuthFlow) => {
    setFlow(next);
    if (next.status === "pending") active.current = { hostId, flowId: next.flowId };
    else { active.current = undefined; setRevision((value) => value + 1); }
  };

  useEffect(() => {
    if (!flow || flow.status !== "pending" || working) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await call<AuthFlow>(hostId, { action: "poll", flowId: flow.flowId });
        if (cancelled) return;
        setError(undefined); setFlow(next);
        if (next.status === "pending") timer = setTimeout(() => void poll(), 800);
        else { active.current = undefined; setRevision((value) => value + 1); }
      } catch (reason) {
        if (!cancelled) { setError(message(reason)); timer = setTimeout(() => void poll(), 3000); }
      }
    };
    timer = setTimeout(() => void poll(), 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hostId, flow?.flowId, flow?.status, working]);

  const perform = async (request: Record<string, unknown>, begin = false) => {
    if (requestPending.current) return;
    requestPending.current = true;
    const current = generation.current;
    setWorking(true); setError(undefined);
    if (begin) setFlow(undefined);
    try {
      const result = await call<AuthFlow>(hostId, request);
      if (current === generation.current) receive(result);
      else if (begin) void cancelFlow(hostId, result.flowId).catch(() => undefined);
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) { setWorking(false); requestPending.current = false; } }
  };

  const logout = async (providerId: string) => {
    if (requestPending.current) return;
    requestPending.current = true;
    const current = generation.current;
    setWorking(true); setError(undefined); setFlow(undefined);
    try {
      const result = await call<Listing>(hostId, { action: "logout", providerId });
      if (current === generation.current) setProviders(result.providers);
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) { setWorking(false); requestPending.current = false; } }
  };

  return {
    providers, flow, loading, working, error,
    refresh: () => { setError(undefined); setRevision((value) => value + 1); },
    begin: (providerId: string, authType: string) => perform({ action: "begin", providerId, authType }, true),
    reply: (answer: string) => flow?.prompt ? perform({ action: "reply", flowId: flow.flowId, promptId: flow.prompt.id, answer }) : Promise.resolve(),
    cancel: () => flow ? perform({ action: "cancel", flowId: flow.flowId }) : Promise.resolve(),
    logout,
  };
}
