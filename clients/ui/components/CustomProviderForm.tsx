import { createSignal } from "solid-js";

import type { CustomProviderInput } from "../lib/providerAuth";

const blankProvider = (): CustomProviderInput => ({ providerId: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", noKey: false, sessionAffinity: false });

const brokerProvider = (): CustomProviderInput => ({
  providerId: "opencode-go-broker", name: "OpenCode Go broker", baseUrl: "http://127.0.0.1:8787/v1", api: "openai-responses", apiKey: "", noKey: false, sessionAffinity: true,
});

export function CustomProviderForm(componentProps: { working: boolean; save: (input: CustomProviderInput) => Promise<boolean>; close: () => void }) {
  const [input, setInput] = createSignal((blankProvider)());
  const [saved, setSaved] = createSignal(false);
  const update = (patch: Partial<CustomProviderInput>) => setInput((previous) => ({ ...previous, ...patch }));

  const submit = async () => {
    const capturedInput = input(); const capturedSave0 = componentProps.save;

 if (await capturedSave0(capturedInput)) { setInput(blankProvider()); setSaved(true); } };

  return <>{saved() ? (<div class="provider-login-panel" role="status"><strong>Custom provider added</strong><p>Enable its models in Inference → Models to use them in a conversation.</p><button onClick={componentProps.close}>Done</button></div>) : (<form class="provider-login-panel custom-provider-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div class="provider-account-actions"><strong>Add custom provider</strong><button type="button" disabled={componentProps.working} onClick={() => setInput(brokerProvider())}>Use Go broker preset</button></div>
    <fieldset disabled={componentProps.working}>
      <div class="custom-provider-grid">
        <label class="field"><span>Provider ID</span><input required pattern="[a-z0-9][a-z0-9_\-]{0,79}" maxLength={80} placeholder="my-provider" value={input().providerId} onInput={(event) => update({ providerId: event.target.value })} /></label>
        <label class="field"><span>Display name</span><input placeholder="My provider" value={input().name} onInput={(event) => update({ name: event.target.value })} /></label>
        <label class="field"><span>API base URL</span><input required type="url" placeholder="http://127.0.0.1:8787/v1" value={input().baseUrl} onInput={(event) => update({ baseUrl: event.target.value })} /></label>
        <label class="field"><span>API format</span><select value={input().api} onChange={(event) => update({ api: event.target.value })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
      </div>
      <label class="custom-provider-check"><input type="checkbox" checked={input().noKey} onInput={(event) => update({ noKey: event.target.checked, apiKey: "" })} />No API key required</label>
      {!input().noKey && <label class="field"><span>API key</span><input type="password" required autocomplete="off" spellcheck={false} value={input().apiKey} onInput={(event) => update({ apiKey: event.target.value })} /><small>For the Go broker, use its dashboard token.</small></label>}
      <label class="custom-provider-check"><input type="checkbox" checked={input().sessionAffinity} onInput={(event) => update({ sessionAffinity: event.target.checked })} />Send a stable session key for cache affinity</label>
      <p class="provider-login-help">The endpoint must be reachable from the selected host. On a remote host, localhost refers to that remote host.</p>
      <p class="provider-login-help">Models are discovered automatically from the provider’s /models endpoint and refreshed periodically. Choose which to use in Inference → Models.</p>
    </fieldset>
    <div class="provider-account-actions"><button type="button" disabled={componentProps.working} onClick={componentProps.close}>Cancel</button><button type="submit" class="primary-button" disabled={componentProps.working}>{componentProps.working ? "Discovering models…" : "Add provider"}</button></div>
  </form>)}</>;
}
