import { createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import { z } from "zod";
import { Rerun } from "@solid-primitives/keyed";
import { Check, Save, X } from "lucide-solid";
import type { AgentProfile, AppSettings, Model, RpcEvent, SessionSummary } from "../types";
import type { SessionRuntimePool } from "../lib/sessionRuntimePool";
import { modelSchema } from "../lib/responseSchemas";
import { createDependencyEffect } from "../lib/solid";
import { agentProfileSchema } from "../lib/agentSchemas";
import { DEFINED_AGENTS_STATUS_KEY } from "../lib/agentProtocol";
import { hostFastModels, rejectsFastMode } from "../lib/fastModels";
import { AgentFields, agentEffortLevels } from "./AgentFields";
import type { McpEditorDraft } from "./McpSettings";

const chatAgentSchema = z.object({ agent: agentProfileSchema.omit({ path_systemprompt: true, path_agent_prompt: true }), systemPrompt: z.string(), agentPrompt: z.string() });

type ChatAgent = { agent: AgentProfile; systemPrompt: string; agentPrompt: string };

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function ChatAgentPane(props: { session: SessionSummary; runtimePool: SessionRuntimePool; settings: AppSettings; agentNames: string[]; onActivate: () => void }) {
  const { runtimePool, transport, releaseHold, hostId } = untrack(() => {
    const transport = props.runtimePool.forSession(props.session);

    return { runtimePool: props.runtimePool, transport, releaseHold: props.runtimePool.hold(transport), hostId: props.session.hostId ?? "local" };
  });
  const [saved, setSaved] = createSignal<ChatAgent>();
  const [draft, setDraft] = createSignal<ChatAgent>();
  const [hostSettings, setHostSettings] = createSignal<AppSettings>();
  const [models, setModels] = createSignal<Model[]>([]);
  const [error, setError] = createSignal<string>();
  const [applying, setApplying] = createSignal(false);
  const [applied, setApplied] = createSignal(false);
  const [mcpDraft, setMcpDraft] = createSignal<McpEditorDraft>();
  const [capError, setCapError] = createSignal<string>();
  const [revision, setRevision] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const dirty = createMemo(() => JSON.stringify(draft()) !== JSON.stringify(saved()));
  const effortProblem = () => {
    const agent = draft()?.agent;

    return agent?.effort && models().length && !agentEffortLevels(models(), agent).includes(agent.effort) ? `The effort ${agent.effort} is unavailable for this model. Choose another effort.` : undefined;
  };
  const edited = () => dirty() || Boolean(capError() || mcpDraft()?.error);
  const problem = () => mcpDraft()?.error ?? capError() ?? (draft() && !draft()?.systemPrompt.trim() ? "The system prompt cannot be empty" : undefined) ?? effortProblem();
  let loads = 0;

  const load = async (keepEdits: boolean) => {
    const request = ++loads;
    setLoading(true);
    await transport.connect();
    const [chat, settings, available] = await Promise.all([
      transport.command({ type: "chat_agent" }, chatAgentSchema),
      hostId === "local" ? props.settings : transport.loadHostSettings(),
      transport.command({ type: "get_available_models" }, z.object({ models: z.array(modelSchema) })),
    ]);

    if (request !== loads) return;

    const next = { ...chat, agent: { ...chat.agent, path_systemprompt: "", path_agent_prompt: "" } };
    setHostSettings(settings); setModels(available.models); setError(undefined); setLoading(false);
    const previous = saved(); const current = draft();

    if (keepEdits && previous && current && edited()) {
      const changed = (before: object, after: object, key: string) => JSON.stringify(Reflect.get(before, key)) !== JSON.stringify(Reflect.get(after, key));
      const keep = (fresh: object, before: object, after: object) => Object.fromEntries([...new Set([...Object.keys(fresh), ...Object.keys(before), ...Object.keys(after)])].map(key => [key, Reflect.get(changed(before, after, key) ? after : fresh, key)]).filter(([, value]) => value !== undefined));
      setSaved(next); setDraft({ ...next, ...keep({ systemPrompt: next.systemPrompt, agentPrompt: next.agentPrompt }, previous, current), agent: keep(next.agent, previous.agent, current.agent) as AgentProfile });

      if (!mcpDraft()?.error && !changed(previous.agent, current.agent, "mcpServers")) setMcpDraft(undefined);

      return;
    }

    setSaved(next); setDraft(structuredClone(next)); setMcpDraft(undefined); setRevision(value => value + 1);
  };

  const reload = () => void load(true).catch(reason => setError(`Could not load the agent of this conversation: ${errorText(reason)}`));

  const [agentsChanged, setAgentsChanged] = createSignal(0);
  createDependencyEffect(() => transport.subscribe((event: RpcEvent) => {
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === DEFINED_AGENTS_STATUS_KEY) setAgentsChanged(value => value + 1);
  }), () => []);
  createDependencyEffect(() => { if (!applying()) reload(); }, () => [agentsChanged()]);

  onCleanup(() => { releaseHold(); runtimePool.detachIdle(transport, () => true); });

  const update = (value: Partial<ChatAgent>) => setDraft(current => current && { ...current, ...value });
  const updateAgent = (value: Partial<AgentProfile>) => setDraft(current => current && { ...current, agent: { ...current.agent, ...value } });

  const apply = async () => {
    const current = draft();

    if (!current || applying() || loading() || problem()) return;
    const { path_systemprompt: _system, path_agent_prompt: _instructions, ...agent } = current.agent;
    setApplying(true); setError(undefined);

    try {
      await transport.command({ type: "set_chat_agent", agent, systemPrompt: current.systemPrompt, agentPrompt: current.agentPrompt });
      await load(false);
      setApplied(true); window.setTimeout(() => setApplied(false), 1600);
    } catch (reason) { setError(errorText(reason)); }
    finally { setApplying(false); }
  };

  const discard = () => {
    setDraft(structuredClone(saved())); setMcpDraft(undefined); setCapError(undefined); setRevision(value => value + 1);

    if (loading()) reload();
  };

  const supportsFastMode = (model: string) => !rejectsFastMode(hostFastModels(hostId)(), model);

  const renderHeader = () => (<div class="agent-name-row"><label class="field"><span>Agent name</span><input aria-label="Agent name" disabled={applying()} aria-invalid={!draft()?.agent.name} value={draft()?.agent.name ?? ""} onInput={event => { updateAgent({ name: event.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, "") }); event.currentTarget.value = draft()?.agent.name ?? ""; }} /></label></div>);

  const renderPrompts = () => (<><label class="field"><span>System prompt</span><textarea class="chat-agent-prompt" aria-label="System prompt" disabled={applying()} aria-invalid={!draft()?.systemPrompt.trim()} rows={10} value={draft()?.systemPrompt ?? ""} onInput={event => update({ systemPrompt: event.currentTarget.value })} /></label><label class="field"><span>Agent prompt</span><textarea class="chat-agent-prompt" aria-label="Agent prompt" disabled={applying()} rows={6} placeholder="Optional instructions after the system prompt" value={draft()?.agentPrompt ?? ""} onInput={event => update({ agentPrompt: event.currentTarget.value })} /></label></>);

  return <section class="chat-agent-pane" aria-label="Agent of this conversation" onFocusIn={() => props.onActivate()}>
    <header class="chat-agent-header">
      <div><h2>Agent of this conversation</h2><p>Changes apply only to this conversation, from the next message.</p></div>
      <div class="settings-save">
        <Show when={edited() && !applying()}><button class="discard-button" onClick={discard}><X size={15} />Discard</button></Show>
        <button class={dirty() && !applying() && !loading() && !problem() ? "primary-button needs-save" : "primary-button"} disabled={!dirty() || applying() || loading() || Boolean(problem())} onClick={() => void apply()}>{applied() && !dirty() ? <Check size={15} /> : <Save size={15} />}{applying() ? "Applying…" : applied() && !dirty() ? "Applied" : "Apply"}</button>
      </div>
      <Show when={error() ?? problem()}>{message => <p class="chat-agent-error" role="alert">{message()}</p>}</Show>
    </header>
    <Show when={draft()} fallback={<Show when={!error()}><p class="empty-small" role="status">Loading the agent…</p></Show>}>{chat => <Show when={hostSettings()}>{settings => <Rerun on={revision}>{(_revision) =>
      <AgentFields agent={chat().agent} update={updateAgent} disabled={applying()} header={untrack(renderHeader)} prompts={untrack(renderPrompts)} hostId={hostId}
        models={models()} modelAliases={settings().modelAliases ?? {}} hiddenModels={new Set(settings().hiddenModels)} defaultThinking={settings().defaultThinking} defaultFastMode={settings().defaultFastMode} supportsFastMode={supportsFastMode}
        tools={settings().tools} skills={settings().skills} onCatalog={catalog => setHostSettings(current => current && { ...current, ...catalog })} agentNames={[...new Set([...props.agentNames, chat().agent.name])]}
        mcpDraft={mcpDraft()} onMcpDraft={setMcpDraft} onCapError={setCapError} />}</Rerun>}</Show>}</Show>
  </section>;
}
