import { localHostLabel } from "../lib/mobileHosts";
import { required } from "../lib/required";
import { Key, Rerun } from "@solid-primitives/keyed";
import { createMemo, createSignal, Index, Show } from "solid-js";
import { createDependencyEffect } from "../lib/solid";

import { ExternalLink, RefreshCw, Search } from "lucide-solid";
import { openExternalUrl } from "../lib/nativeTransport";
import { isMobile } from "../lib/platform";
import { useProviderAuth, type AuthFlow, type AuthNotice, type ProviderAccount } from "../lib/providerAuth";
import "../provider-settings.css";
import type { RemoteHost } from "../types";
import { CustomProviderForm } from "./CustomProviderForm";

type AuthControls = ReturnType<typeof useProviderAuth>;


function selectedHostName(hosts: RemoteHost[], hostId: string) {
  return hostId === "local" ? localHostLabel() : hosts.find((host) => host.id === hostId)?.name || hostId;
}

function LoginLink(componentProps: { url: string; label: string }) {
  const [error, setError] = createSignal<string>();

  return <span class="provider-login-link"><button type="button" onClick={() => void openExternalUrl(componentProps.url).catch(() => setError("Could not open the browser. Copy the link and open it in your browser."))}><ExternalLink size={14} />{componentProps.label}</button><input aria-label="Login link" readOnly value={componentProps.url} onFocus={(event) => event.target.select()} />{error() && <small role="alert">{(error())}</small>}</span>;
}

function LoginNotice(componentProps: { notice: AuthNotice }) {
  return <div class="provider-login-notice">
    {componentProps.notice.message && <p>{componentProps.notice.message}</p>}
    {componentProps.notice.userCode && <p>Enter this code: <strong class="provider-device-code">{componentProps.notice.userCode}</strong></p>}
    {componentProps.notice.url && <LoginLink url={componentProps.notice.url} label="Open provider login" />}
    {<Key each={componentProps.notice.links?.filter((link) => link.url)} by={(link) => link.url}>{(link, _index) => <LoginLink  url={required(link().url)} label={link().label || "Open provider page"} />}</Key>}
  </div>;
}

function LoginPrompt(componentProps: { prompt: NonNullable<AuthFlow["prompt"]>; working: boolean; reply: (answer: string) => Promise<void> }) {
  const [answer, setAnswer] = createSignal("");
  const submit = () => { const value = answer(); setAnswer(""); void componentProps.reply(value); };

  return <form class="provider-login-prompt" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <label class="field"><span>{componentProps.prompt.message}</span>
      {componentProps.prompt.type === "select" ? <select autofocus value={answer()} onChange={(event) => setAnswer(event.target.value)} disabled={componentProps.working}><option value="">Select an option</option>{<Key each={componentProps.prompt.options} by={(option) => option.id}>{(option, _index) => <option  value={option().id}>{option().label}{option().description ? ` — ${option().description}` : ""}</option>}</Key>}</select>
        : <input autofocus type={componentProps.prompt.type === "secret" || componentProps.prompt.type === "manual_code" ? "password" : "text"} value={answer()} onInput={(event) => setAnswer(event.target.value)} placeholder={componentProps.prompt.placeholder} autocomplete="off" autoCapitalize="none" spellcheck={false} disabled={componentProps.working} />}
    </label>
    {componentProps.prompt.type === "manual_code" && <p class="provider-login-help">If the callback page cannot open on this device, paste its full address or the code requested by the provider.</p>}
    <button class="primary-button" disabled={componentProps.working || (componentProps.prompt.type !== "text" && !answer().trim())} type="submit">Continue</button>
  </form>;
}

function FlowStatus(componentProps: { flow: AuthFlow }) {

  return <>{componentProps.flow.status === "complete" ? (<p role="status">Credentials saved on this host.</p>) : componentProps.flow.status === "cancelled" ? (<p role="status">Login cancelled.</p>) : componentProps.flow.status === "failed" ? (<p class="provider-error" role="alert">{componentProps.flow.error}</p>) : (<p role="status">Waiting for provider login…</p>)}</>;
}

export function ProviderSettings(componentProps: { hosts: RemoteHost[]; initialHostId?: string; fixedHost?: boolean }) {
  const [hostId, setHostId] = createSignal((componentProps.initialHostId === undefined ? "local" : componentProps.initialHostId));
  const [filter, setFilter] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const auth = useProviderAuth(() => (hostId()));
  const active = createMemo(() => (auth.flow?.status === "pending"));
  const disabled = createMemo(() => (auth.working || active()));
  createDependencyEffect(() => {
    const capturedHostId = hostId(); const capturedFixedHost0 = componentProps.fixedHost; const capturedHosts1 = componentProps.hosts;

 if (!(capturedFixedHost0 === undefined ? false : capturedFixedHost0) && capturedHostId !== "local" && !capturedHosts1.some((host) => host.id === capturedHostId)) setHostId("local"); }, () => [hostId(), componentProps.hosts, (componentProps.fixedHost === undefined ? false : componentProps.fixedHost)]);
  const hostName = createMemo(() => (selectedHostName(componentProps.hosts, hostId())));

  const providers = createMemo(() => auth.providers.filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(filter().toLowerCase().trim())).sort((left, right) => Number(right.configured) - Number(left.configured)));

  const loadingProviders = () => auth.loading && !auth.providers.length;

  return <div class="settings-section provider-settings">
    <div class="section-title"><div><h2>Providers</h2><p>Sign in to providers on the host running Pi. Credentials stay on that host and remain available after you disconnect.</p></div></div>
    <div class="provider-toolbar">
      {!(componentProps.fixedHost === undefined ? false : componentProps.fixedHost) && <label>Host <select aria-label="Provider host" value={hostId()} disabled={disabled()} onChange={(event) => setHostId(event.target.value)}><option value="local">{localHostLabel()}</option>{<Key each={componentProps.hosts.filter((host) => host.enabled !== false)} by={(host) => host.id}>{(host, _index) => <option  value={host().id}>{host().name}</option>}</Key>}</select></label>}
      <label class="section-filter"><Search size={14} /><input aria-label="Filter providers" placeholder="Filter providers" value={filter()} onInput={(event) => setFilter(event.target.value)} /></label>
      <button class="section-toggle-all" disabled={auth.loading || disabled()} onClick={auth.refresh}><RefreshCw size={14} />Refresh</button>
      <button class="section-toggle-all provider-add-custom" disabled={disabled() || adding()} onClick={() => setAdding(true)}>Add custom provider</button>
    </div>
    {auth.error && <p class="provider-error" role="alert">{auth.error}</p>}
    {adding() && <Rerun on={() => hostId()}>{(_key) => <CustomProviderForm  working={!!disabled()} save={auth.createProvider} close={() => setAdding(false)} />}</Rerun>}
    <Show when={auth.flow}>{flow => <LoginPanel flow={flow()} auth={auth} />}</Show>
    {loadingProviders() && <div class="empty-small" role="status">Loading providers on {hostName()}…</div>}
    <ProviderList providers={providers()} auth={auth} disabled={disabled()} />
    <p class="provider-login-help">Removing a saved login leaves credentials from environment variables or other host configuration in place.</p>
  </div>;
}

function LoginPanel(componentProps: { flow: AuthFlow; auth: AuthControls }) {
  const promptId = createMemo(() => componentProps.flow.prompt?.id);

  return <div class="provider-login-panel" aria-label="Provider login">
    <strong>{componentProps.flow.name ?? componentProps.auth.providers.find((provider) => provider.id === componentProps.flow.providerId)?.name ?? componentProps.flow.providerId}</strong>
    <FlowStatus flow={componentProps.flow} />
    {<Index each={componentProps.flow.notices}>{(notice, _index) => <LoginNotice  notice={notice()} />}</Index>}
    {componentProps.flow.prompt && <Rerun on={promptId}>{(_key) => <LoginPrompt  prompt={required(componentProps.flow.prompt)} working={componentProps.auth.working} reply={componentProps.auth.reply} />}</Rerun>}
    {componentProps.flow.status === "pending" && <button type="button" disabled={componentProps.auth.working} onClick={() => void componentProps.auth.cancel()}>Cancel login</button>}
  </div>;
}

function ProviderList(componentProps: { providers: ProviderAccount[]; auth: AuthControls; disabled: boolean }) {
  return <><div class="config-list"><Key each={componentProps.providers} by={provider => provider.id}>{provider => <section class="provider-group" aria-label={provider().name}>
    <div class="provider-account provider-heading">
      <div><strong>{provider().name}</strong><small>{provider().configured ? "Configured" : "Not configured"}{provider().source && <> · <span class={provider().source === "stored" ? "provider-stored" : undefined}>{provider().source}</span></>}</small></div>
      <div class="provider-account-actions"><Index each={provider().methods}>{method => method().interactive
        ? <button disabled={componentProps.disabled || componentProps.auth.loading} onClick={() => void componentProps.auth.begin(provider().id, method().type)}>{provider().configured ? "Replace login" : "Sign in"} · {method().name}</button>
        : <small>Configured through the host environment</small>}</Index>
        {provider().storedType && <button disabled={componentProps.disabled || componentProps.auth.loading} onClick={() => void componentProps.auth.logout(provider().id)}>Remove saved login</button>}
      </div>
    </div>
  </section>}</Key></div>
    {!componentProps.auth.loading && !componentProps.auth.error && !componentProps.providers.length && <div class="empty-small">No providers match.</div>}
  </>;
}
