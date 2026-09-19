import type { GoBrokerSettings } from "../types";
import { Toggle } from "./Toggle";

export const defaultGoBrokerSettings: GoBrokerSettings = { enabled: false };

export function BrokerControls({ settings, onChange }: { settings: GoBrokerSettings; onChange: (settings: GoBrokerSettings) => void }) {
  return <Toggle label="Enable OpenCode Go key broker" title="Automatically distribute conversations across OpenCode Go accounts" checked={settings.enabled} onChange={(enabled) => onChange({ enabled })} />;
}

export function PluginSettings({ broker, onBrokerChange }: { broker: GoBrokerSettings; onBrokerChange: (settings: GoBrokerSettings) => void }) {
  return <div className="settings-section">
    <div className="section-title"><div><h2>Plugins</h2><p>App-wide extensions for all agents and conversations. Changes apply after saving, when each conversation is idle.</p></div></div>
    <section className="provider-group" aria-label="OpenCode Go key broker">
      <div className="provider-account provider-heading">
        <div><strong>OpenCode Go key broker</strong><small>Balance new conversations across available accounts while keeping existing conversations on the same account. Automatically retry another account if a request fails before output starts.</small></div>
        <div className="provider-account-actions"><BrokerControls settings={broker} onChange={onBrokerChange} /></div>
      </div>
    </section>
  </div>;
}
