import { useEffect, useState } from "react";
import "../provider-settings.css";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import type { RemoteHost } from "../types";
import { isMobile } from "../lib/platform";
import { openExternalUrl } from "../lib/nativeTransport";
import { useProviderAuth, type AuthFlow, type AuthNotice, type ProviderAccount } from "../lib/providerAuth";

type AuthControls = ReturnType<typeof useProviderAuth>;
type ProviderGroup = {
  key: string; name: string; base: ProviderAccount;
  method: ProviderAccount["methods"][number]; accounts: ProviderAccount[];
};

function providerGroups(providers: ProviderAccount[]): ProviderGroup[] {
  const families = new Map<string, ProviderAccount[]>();
  for (const provider of providers) {
    const accounts = families.get(provider.providerId) ?? [];
    accounts.push(provider); families.set(provider.providerId, accounts);
  }
  return [...families.values()].flatMap((accounts) => {
    const base = accounts.find((account) => account.number === 1) ?? accounts[0];
    return base.methods.map((method) => ({
      key: `${base.providerId}:${method.type}`,
      name: base.methods.length > 1 ? method.name : base.name.replace(/ #\d+$/, ""),
      base, method,
      accounts: accounts.filter((account) => account.storedType === method.type || (!account.storedType && account.configured && method.type === "api_key")).sort((a, b) => a.number - b.number),
    }));
  });
}
const localHostLabel = isMobile ? "Connected daemon" : "This computer";
function selectedHostName(hosts: RemoteHost[], hostId: string) {
  return hostId === "local" ? localHostLabel : hosts.find((host) => host.id === hostId)?.name || hostId;
}

function LoginLink({ url, label }: { url: string; label: string }) {
  const [error, setError] = useState<string>();
  return <span className="provider-login-link"><button type="button" onClick={() => void openExternalUrl(url).catch(() => setError("Could not open the browser. Copy the link and open it in your browser."))}><ExternalLink size={14} />{label}</button><input aria-label="Login link" readOnly value={url} onFocus={(event) => event.target.select()} />{error && <small role="alert">{error}</small>}</span>;
}

function LoginNotice({ notice }: { notice: AuthNotice }) {
  return <div className="provider-login-notice">
    {notice.message && <p>{notice.message}</p>}
    {notice.userCode && <p>Enter this code: <strong className="provider-device-code">{notice.userCode}</strong></p>}
    {notice.url && <LoginLink url={notice.url} label="Open provider login" />}
    {notice.links?.filter((link) => link.url).map((link) => <LoginLink key={link.url} url={link.url!} label={link.label || "Open provider page"} />)}
  </div>;
}

function LoginPrompt({ prompt, working, reply }: { prompt: NonNullable<AuthFlow["prompt"]>; working: boolean; reply: (answer: string) => Promise<void> }) {
  const [answer, setAnswer] = useState("");
  const submit = () => { const value = answer; setAnswer(""); void reply(value); };
  return <form className="provider-login-prompt" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <label className="field"><span>{prompt.message}</span>
      {prompt.type === "select" ? <select autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={working}><option value="">Select an option</option>{prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>)}</select>
        : <input autoFocus type={prompt.type === "secret" || prompt.type === "manual_code" ? "password" : "text"} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={prompt.placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={working} />}
    </label>
    {prompt.type === "manual_code" && <p className="provider-login-help">If the callback page cannot open on this device, paste its full address or the code requested by the provider.</p>}
    <button className="primary-button" disabled={working || (prompt.type !== "text" && !answer.trim())} type="submit">Continue</button>
  </form>;
}

function FlowStatus({ flow }: { flow: AuthFlow }) {
  if (flow.status === "complete") return <p role="status">Credentials saved on this host.</p>;
  if (flow.status === "cancelled") return <p role="status">Login cancelled.</p>;
  if (flow.status === "failed") return <p className="provider-error" role="alert">{flow.error}</p>;
  return <p role="status">Waiting for provider login…</p>;
}

export function ProviderSettings({ hosts, initialHostId = "local", fixedHost = false }: { hosts: RemoteHost[]; initialHostId?: string; fixedHost?: boolean }) {
  const [hostId, setHostId] = useState(initialHostId);
  const [filter, setFilter] = useState("");
  const auth = useProviderAuth(hostId);
  const active = auth.flow?.status === "pending";
  const disabled = auth.working || active;
  useEffect(() => { if (!fixedHost && hostId !== "local" && !hosts.some((host) => host.id === hostId)) setHostId("local"); }, [hostId, hosts, fixedHost]);
  const hostName = selectedHostName(hosts, hostId);
  const providers = providerGroups(auth.providers).filter((group) => `${group.name} ${group.base.providerId} ${group.accounts.map((account) => account.name).join(" ")}`.toLowerCase().includes(filter.toLowerCase().trim()))
    .sort((left, right) => Number(right.accounts.length > 0) - Number(left.accounts.length > 0));
  return <div className="settings-section provider-settings">
    <div className="section-title"><div><h2>Providers</h2><p>Sign in to providers on the machine running Pi. Credentials stay on that host and remain available after you disconnect.</p></div></div>
    <div className="provider-toolbar">
      {!fixedHost && <label>Host <select aria-label="Provider host" value={hostId} disabled={disabled} onChange={(event) => setHostId(event.target.value)}><option value="local">{localHostLabel}</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>}
      <label className="section-filter"><Search size={14} /><input aria-label="Filter providers" placeholder="Filter providers" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <button className="section-toggle-all" disabled={auth.loading || disabled} onClick={auth.refresh}><RefreshCw size={14} />Refresh</button>
    </div>
    {auth.error && <p className="provider-error" role="alert">{auth.error}</p>}
    {auth.flow && <LoginPanel flow={auth.flow} auth={auth} />}
    {auth.loading && <div className="empty-small" role="status">Loading providers on {hostName}…</div>}
    <ProviderList providers={providers} auth={auth} disabled={disabled} />
    <p className="provider-login-help">Removing a saved login leaves credentials from environment variables or other host configuration in place. Voice uses the host’s separate Codex login.</p>
  </div>;
}

function LoginPanel({ flow, auth }: { flow: AuthFlow; auth: AuthControls }) {
  return <div className="provider-login-panel" aria-label="Provider login">
    <strong>{flow.name ?? auth.providers.find((provider) => provider.id === flow.providerId)?.name ?? flow.providerId}</strong>
    <FlowStatus flow={flow} />
    {flow.notices.map((notice, index) => <LoginNotice key={`${index}:${notice.url ?? notice.message}`} notice={notice} />)}
    {flow.prompt && <LoginPrompt key={flow.prompt.id} prompt={flow.prompt} working={auth.working} reply={auth.reply} />}
    {flow.status === "pending" && <button type="button" disabled={auth.working} onClick={() => void auth.cancel()}>Cancel login</button>}
  </div>;
}

function ProviderList({ providers, auth, disabled }: { providers: ProviderGroup[]; auth: AuthControls; disabled: boolean }) {
  return <><div className="config-list">{providers.map((group) => <section className="provider-group" key={group.key} aria-label={group.name}>
    <div className="provider-account provider-heading">
      <div><strong>{group.name}</strong>{!group.accounts.length && <small>Not configured</small>}</div>
      <div className="provider-account-actions">{group.method.interactive
        ? <button disabled={disabled || auth.loading} onClick={() => void auth.begin(group.base.id, group.method.type, group.base.configured || !!group.base.storedType)}>Add account</button>
        : <small>Configured through the host environment</small>}</div>
    </div>
    {group.accounts.map((account) => <div className="provider-account provider-account-child" key={account.id}>
      <div><strong>{group.name} #{account.number}</strong><small>Configured{account.source && <> · <span className={account.source === "stored" ? "provider-stored" : undefined}>{account.source}</span></>}</small></div>
      <div className="provider-account-actions">{account.storedType && <button disabled={disabled || auth.loading} onClick={() => void auth.logout(account.id)}>Remove saved login</button>}</div>
    </div>)}
  </section>)}</div>
    {!auth.loading && !auth.error && !providers.length && <div className="empty-small">No providers match.</div>}
  </>;
}
