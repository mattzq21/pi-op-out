import { useState } from "react";
import type { CustomProviderInput } from "../lib/providerAuth";

const blankProvider = (): CustomProviderInput => ({ providerId: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", noKey: false, sessionAffinity: false });
const brokerProvider = (): CustomProviderInput => ({
  providerId: "opencode-go-broker", name: "OpenCode Go broker", baseUrl: "http://127.0.0.1:8787/v1", api: "openai-responses", apiKey: "", noKey: false, sessionAffinity: true,
});

export function CustomProviderForm({ working, save, close }: { working: boolean; save: (input: CustomProviderInput) => Promise<boolean>; close: () => void }) {
  const [input, setInput] = useState(blankProvider);
  const [saved, setSaved] = useState(false);
  const update = (patch: Partial<CustomProviderInput>) => setInput((previous) => ({ ...previous, ...patch }));
  const submit = async () => { if (await save(input)) { setInput(blankProvider()); setSaved(true); } };
  if (saved) return <div className="provider-login-panel" role="status"><strong>Custom provider added</strong><p>Enable its models in Settings → Models to use them in a conversation.</p><button onClick={close}>Done</button></div>;
  return <form className="provider-login-panel custom-provider-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div className="provider-account-actions"><strong>Add custom provider</strong><button type="button" disabled={working} onClick={() => setInput(brokerProvider())}>Use Go broker preset</button></div>
    <fieldset disabled={working}>
      <div className="custom-provider-grid">
        <label className="field"><span>Provider ID</span><input required pattern="[a-z0-9][a-z0-9_\-]{0,79}" maxLength={80} placeholder="my-provider" value={input.providerId} onChange={(event) => update({ providerId: event.target.value })} /></label>
        <label className="field"><span>Display name</span><input placeholder="My provider" value={input.name} onChange={(event) => update({ name: event.target.value })} /></label>
        <label className="field"><span>API base URL</span><input required type="url" placeholder="http://127.0.0.1:8787/v1" value={input.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} /></label>
        <label className="field"><span>API format</span><select value={input.api} onChange={(event) => update({ api: event.target.value })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
      </div>
      <label className="custom-provider-check"><input type="checkbox" checked={input.noKey} onChange={(event) => update({ noKey: event.target.checked, apiKey: "" })} />No API key required</label>
      {!input.noKey && <label className="field"><span>API key</span><input type="password" required autoComplete="off" spellCheck={false} value={input.apiKey} onChange={(event) => update({ apiKey: event.target.value })} /><small>For the Go broker, use its dashboard token.</small></label>}
      <label className="custom-provider-check"><input type="checkbox" checked={input.sessionAffinity} onChange={(event) => update({ sessionAffinity: event.target.checked })} />Send a stable session key for cache affinity</label>
      <p className="provider-login-help">The endpoint must be reachable from the selected host. On a remote host, localhost refers to that remote machine.</p>
      <p className="provider-login-help">Models are discovered automatically from the provider’s /models endpoint and refreshed periodically. Choose which to use in Settings → Models.</p>
    </fieldset>
    <div className="provider-account-actions"><button type="button" disabled={working} onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={working}>{working ? "Discovering models…" : "Add provider"}</button></div>
  </form>;
}
