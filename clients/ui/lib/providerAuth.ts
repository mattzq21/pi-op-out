import { z } from "zod";
import { authFlowSchema, providerListingSchema } from "./responseSchemas";
import { required } from "./required";
import { type Accessor, createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "./solid";

import { invoke, listen, type UnlistenFn } from "./platform";

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
  name?: string;
  status: "pending" | "complete" | "cancelled" | "failed";
  notices: AuthNotice[];
  error?: string;
  prompt?: { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> };
}

export interface CustomProviderInput {
  providerId: string; name: string; baseUrl: string; api: string; apiKey: string; noKey: boolean; sessionAffinity: boolean;
}

type AuthFlowRequest =
  | { action: "begin"; providerId: string; authType: string }
  | { action: "reply"; flowId: string; promptId: string; answer: string }
  | { action: "cancel" | "poll"; flowId: string };

type ProviderAuthRequest = AuthFlowRequest
  | { action: "list"; refreshModels: boolean }
  | { action: "logout"; providerId: string }
  | ({ action: "create" } & CustomProviderInput);

const call = <S extends z.ZodType>(hostId: string, request: ProviderAuthRequest, schema: S) => invoke("provider_auth", { hostId, request }, schema);

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

const cancelFlow = (hostId: string, flowId: string) => call(hostId, { action: "cancel", flowId }, authFlowSchema);

const INTERRUPTED = "Provider login was interrupted on the host. Start again.";

const TRANSIENT_HINT = "Host is busy";

export function useProviderAuth(hostId: Accessor<string>) {
  const [providers, setProviders] = createSignal<ProviderAccount[]>([]);
  const [flow, setFlow] = createSignal<AuthFlow>();
  const [loading, setLoading] = createSignal(true);
  const [working, setWorking] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [revision, setRevision] = createSignal(0);
  const [tick, setTick] = createSignal(0);
  const generation = createRef(0);
  const active = createRef<{ hostId: string; flowId: string } | undefined>(undefined);
  const requestPending = createRef(false);
  const refreshModels = createRef(false);

  createDependencyEffect(() => {
    generation.current++;
    setProviders([]); setFlow(undefined); setLoading(true); setWorking(false); setError(undefined);
    requestPending.current = false;

    return () => {
      generation.current++;
      const previous = active.current;
      active.current = undefined;

      if (previous) void cancelFlow(previous.hostId, previous.flowId).catch(() => undefined);
    };
  }, () => [hostId()]);

  createDependencyEffect(() => { const capturedHostId = hostId();
    let cancelled = false;
    setLoading(true);
    const discover = refreshModels.current;
    refreshModels.current = false;
    void call(capturedHostId, { action: "list", refreshModels: discover }, providerListingSchema).then((listing) => { if (!cancelled) { setProviders(listing.providers);

    if (listing.warning) setError(listing.warning); } })
      .catch((reason) => { if (!cancelled) setError(message(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, () => [hostId(), revision()]);

  createDependencyEffect(() => { const capturedHostId = hostId();
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen("pi://provider-auth-changed", ({ payload }) => {
      if (cancelled || payload.hostId !== capturedHostId) return;
      if (payload.flow && payload.flow.flowId === flow()?.flowId && payload.flow.status !== "pending") {
        receive(payload.flow);
      }
      setTick((value) => value + 1);
      setRevision((value) => value + 1);
    }, z.object({ hostId: z.string(), flow: authFlowSchema.nullish() })).then((stop) => {
      if (cancelled) void stop(); else unlisten = stop;
    }).catch(() => undefined);

    return () => { cancelled = true; unlisten?.(); };
  }, () => [hostId()]);

  const receive = (next: AuthFlow) => {
    const current = flow();
    if (current?.flowId === next.flowId && current.status !== "pending" && next.status === "pending") return;
    setFlow(next);

    if (next.status === "pending") active.current = { hostId: hostId(), flowId: next.flowId };
    else { active.current = undefined; setRevision((value) => value + 1); }
  };

  createDependencyEffect(() => { const capturedFlow = flow(); const capturedWorking = working(); const capturedHostId = hostId();

    if (!capturedFlow || (capturedFlow).status !== "pending" || capturedWorking) return;
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const next = await call(capturedHostId, { action: "poll", flowId: (capturedFlow).flowId }, authFlowSchema);

        if (cancelled) return;
        setError(undefined); setFlow(next);
        failures = 0;

        if (next.status === "pending") timer = setTimeout(() => void poll(), 5000);
        else { active.current = undefined; setRevision((value) => value + 1); }
      } catch (reason) {
        if (cancelled) return;
        failures += 1;
        const reasonText = message(reason);
        const lost = failures >= 2 && !reasonText.includes(TRANSIENT_HINT);

        if (lost) {
          void cancelFlow(capturedHostId, (capturedFlow).flowId).catch(() => undefined);
          active.current = undefined;
          setFlow(undefined);
          setRevision((value) => value + 1);
          setError(INTERRUPTED);

          return;
        }

        setError(reasonText);
        timer = setTimeout(() => void poll(), 1500);
      }
    };

    timer = setTimeout(() => void poll(), 400);

    return () => { cancelled = true; clearTimeout(timer); };
  }, () => [hostId(), flow()?.flowId, flow()?.status, working(), tick()]);

  const perform = async (request: AuthFlowRequest, begin = false) => { const capturedHostId = hostId();

    if (requestPending.current) return;
    requestPending.current = true;
    const current = generation.current;
    setWorking(true); setError(undefined);

    if (begin) setFlow(undefined);

    try {
      const result = await call(capturedHostId, request, authFlowSchema);

      if (current === generation.current) receive(result);
      else if (begin) void cancelFlow(capturedHostId, result.flowId).catch(() => undefined);
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) { setWorking(false); requestPending.current = false; } }
  };

  const logout = async (providerId: string) => { const capturedHostId = hostId();

    if (requestPending.current) return;
    requestPending.current = true;
    const current = generation.current;
    setWorking(true); setError(undefined); setFlow(undefined);

    try {
      const result = await call(capturedHostId, { action: "logout", providerId }, providerListingSchema);

      if (current === generation.current) setProviders(result.providers);
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) { setWorking(false); requestPending.current = false; } }
  };

  const createProvider = async (input: CustomProviderInput) => { const capturedHostId = hostId();

    if (requestPending.current) return false;
    requestPending.current = true;
    const current = generation.current;
    setWorking(true); setError(undefined); setFlow(undefined);

    try {
      const result = await call(capturedHostId, { action: "create", ...input }, z.object({ created: z.boolean(), warning: z.string().optional() }));

      if (current !== generation.current) return false;
      setError(result.warning); setRevision((value) => value + 1);

      return result.created;
    } catch (reason) { if (current === generation.current) setError(message(reason));

    return false; }
    finally { if (current === generation.current) { setWorking(false); requestPending.current = false; } }
  };

  return {
    get providers() { return providers(); }, get flow() { return flow(); }, get loading() { return loading(); }, get working() { return working(); }, get error() { return error(); },
    refresh: () => { refreshModels.current = true; setError(undefined); setRevision((value) => value + 1); },
    begin: (providerId: string, authType: string) => perform({ action: "begin", providerId, authType }, true),
    reply: (answer: string) => flow()?.prompt ? perform({ action: "reply", flowId: required((flow())).flowId, promptId: required(required((flow())).prompt).id, answer }) : Promise.resolve(),
    cancel: () => flow() ? perform({ action: "cancel", flowId: required((flow())).flowId }) : Promise.resolve(),
    get logout() { return logout; }, get createProvider() { return createProvider; },
  };
}
