import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js";
import { Check, CircleAlert, Copy } from "lucide-solid";
import { IconButton } from "./IconButton";
import { renderDiagram } from "../lib/diagrams";
import type { Workflow, WorkflowInput, WorkflowOptions, WorkflowRun } from "../lib/workflows/model";
import "./workflow.css";

export function WorkflowSidebar(props: { runs: WorkflowRun[]; selected?: string; query: string; onSelect: (id?: string) => void }) {
  const [collapsed, setCollapsed] = createSignal(false);
  return <section class="workflow-sidebar" aria-label="Workflows">
    <div class="workflow-group-title"><button onClick={() => setCollapsed(!collapsed())} aria-expanded={!collapsed()}> {collapsed() ? "▸" : "▾"} Workflows <small>{props.runs.length}</small></button><button aria-label="New workflow" title="New workflow" onClick={() => props.onSelect()}>+</button></div>
    <Show when={!collapsed()}><div class="workflow-list"><For each={props.runs.filter((run) => run.name.toLowerCase().includes(props.query.toLowerCase()))}>{(run) =>
      <button class="workflow-row" classList={{ active: props.selected === run.id }} onClick={() => props.onSelect(run.id)} title={run.name}>
        <span class={`workflow-dot ${run.status}`} /><span>{run.name}</span><small>{run.status}</small>
      </button>
    }</For><Show when={!props.runs.length}><button class="workflow-empty" onClick={() => props.onSelect()}>Implement and review…</button></Show></div></Show>
  </section>;
}

function WorkflowDiagram(props: { definition: Workflow; run?: WorkflowRun; onSelect: (id: string) => void }) {
  const [svg, setSvg] = createSignal("");
  const [error, setError] = createSignal("");
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "error">("idle");
  const source = createMemo(() => props.definition.mermaid(props.run));
  let revision = 0;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let root!: HTMLDivElement;
  onCleanup(() => { revision++; clearTimeout(copyTimer); });
  const copy = async () => {
    clearTimeout(copyTimer);
    try { await navigator.clipboard.writeText(source()); setCopyState("copied"); }
    catch { setCopyState("error"); }
    copyTimer = setTimeout(() => setCopyState("idle"), 1800);
  };
  createEffect(() => {
    const version = ++revision;
    setError("");
    void renderDiagram(source(), true, () => version === revision).then((result) => {
      if (version !== revision || !result) return;
      setSvg(result);
      for (const node of props.definition.nodes) {
        const element = root.querySelector(`g.node.wf-${node.id}`);
        element?.setAttribute("tabindex", "0"); element?.setAttribute("role", "button"); element?.setAttribute("aria-label", `${node.label}: inspect block`);
      }
    }).catch((reason) => { if (version === revision) setError(String(reason)); });
  });
  const select = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const element = target.closest("g.node");
    const node = props.definition.nodes.find((node) => element?.classList.contains(`wf-${node.id}`));
    if (node) props.onSelect(node.id);
  };
  return <section class="workflow-diagram" aria-label="Workflow diagram">
    <div class="workflow-diagram-heading"><span>Click a block to inspect it</span><IconButton type="button" label={copyState() === "copied" ? "Mermaid source copied" : copyState() === "error" ? "Copy failed; try again" : "Copy Mermaid source"} onClick={() => void copy()}>{copyState() === "copied" ? <Check size={16} /> : copyState() === "error" ? <CircleAlert size={16} /> : <Copy size={16} />}</IconButton></div>
    <div ref={root} class="workflow-svg" innerHTML={svg()} onClick={(event) => select(event.target)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(event.target); } }} />
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </section>;
}

function WorkflowFields(props: { fields: readonly WorkflowInput[]; options: WorkflowOptions; disabled: boolean; onChange: (field: WorkflowInput, value: string | number) => void }) {
  return <div class="workflow-fields"><For each={props.fields}>{(field) => {
    if (field.type === "textarea") return <label>{field.label}<textarea required={field.required} disabled={props.disabled} placeholder={field.placeholder} value={props.options.intent} rows={5} onInput={(event) => props.onChange(field, event.currentTarget.value)} /></label>;
    return <label>{field.label}<input type="number" required disabled={props.disabled} min={field.min} max={field.max} step={field.step} value={props.options.limits[field.key]} onInput={(event) => props.onChange(field, event.currentTarget.valueAsNumber)} /></label>;
  }}</For></div>;
}

export function WorkflowView(props: { definition: Workflow; run?: WorkflowRun; defaults: Omit<WorkflowOptions, "intent" | "limits">; storageError?: string; onStart: (options: WorkflowOptions) => void; onCancel: (id: string) => void; onNew: () => void }) {
  const formId = createUniqueId();
  const initialNode = () => props.definition.nodes[0]?.id ?? "config";
  const [selected, setSelected] = createSignal(initialNode());
  const [draft, setDraft] = createSignal(props.definition.defaultOptions(props.defaults));
  const [error, setError] = createSignal("");
  const node = createMemo(() => props.definition.nodes.find((node) => node.id === selected()));
  const options = createMemo(() => props.run?.options ?? { ...draft(), ...props.defaults });
  const blocks = createMemo(() => props.run?.blocks.filter((block) => block.nodeId === selected()).slice().reverse() ?? []);
  const change = (field: WorkflowInput, value: string | number) => {
    setError("");
    setDraft((current) => field.type === "textarea" ? { ...current, intent: String(value) } : { ...current, limits: { ...current.limits, [field.key]: Number(value) } });
  };
  const start = () => {
    setError("");
    const issue = props.definition.inputIssue(options());
    if (issue) { setSelected(issue.nodeId); setError(issue.message); return; }
    try { props.onStart(options()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <main class="workflow-view">
    <div class="workflow-config" aria-label="Workflow configuration">
        <form id={formId} class="workflow-form" onSubmit={(event) => { event.preventDefault(); start(); }}>
          <WorkflowFields fields={props.definition.inputs} options={options()} disabled={Boolean(props.run)} onChange={change} />
          <For each={props.definition.nodes.filter((item) => item.inputs?.length)}>{(item) => <WorkflowFields fields={item.inputs!} options={options()} disabled={Boolean(props.run)} onChange={change} />}</For>
        </form>
    </div>
    <div class="workflow-inspector"><WorkflowDiagram definition={props.definition} run={props.run} onSelect={setSelected} />
      <div class="workflow-details" aria-label="Workflow details">
        <div class="workflow-block-tabs"><For each={props.definition.nodes}>{(item) => <button aria-pressed={selected() === item.id} onClick={() => setSelected(item.id)}>{item.label}</button>}</For></div>
        <h2>{node()?.label ?? props.definition.name}</h2>
        <Show when={node()}>{(selectedNode) => <p>{selectedNode().description}</p>}</Show>
        <Show when={props.run && node() && !blocks().length}><p class="workflow-note">This block has not run yet.</p></Show>
        <For each={blocks()}>{(block) => <article class="workflow-block-detail"><h3>Iteration {block.iteration} · {block.status}</h3><small>{new Date(block.startedAt).toLocaleString()}</small>
          <details><summary>Input</summary><pre>{block.input}</pre></details><Show when={block.output}><h4>Result</h4><pre>{block.output}</pre></Show>
        </article>}</For>
      </div>
    </div>
    <div class="workflow-run-controls">
      <Show when={error()}><p role="alert">{error()}</p></Show>
      <Show when={props.storageError}><p role="alert">{props.storageError}</p></Show>
      <Show when={!props.run}><button type="submit" form={formId} class="primary-button">Start workflow</button></Show>
      <Show when={props.run}>{(run) => <>
        <div class="workflow-summary"><strong class={`workflow-status ${run().status}`}>{run().status}</strong><span>Review {run().iteration} / {run().options.limits.iterations}</span><span>${run().cost.toFixed(3)} / ${run().options.limits.cost.toFixed(2)}</span></div>
        <div class="workflow-actions"><Show when={run().status === "running"}><button onClick={() => props.onCancel(run().id)}>Stop workflow</button></Show><button onClick={props.onNew}>New workflow</button></div>
        <Show when={run().message}><pre class="workflow-result" role="status">{run().message}</pre></Show>
      </>}</Show>
    </div>
  </main>;
}
