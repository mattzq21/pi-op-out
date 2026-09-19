import { Settings2 } from "lucide-react";
import type { GoBrokerSettings } from "../types";
import { Toggle } from "./Toggle";

export const defaultGoBrokerSettings: GoBrokerSettings = { enabled: false, failover: true };

export function BrokerControls({ settings, onChange, onSettings }: { settings: GoBrokerSettings; onChange: (settings: GoBrokerSettings) => void; onSettings: () => void }) {
  return <>
    <Toggle label="Enable OpenCode Go key broker" title="Automatically distribute conversations across OpenCode Go accounts" checked={settings.enabled} onChange={(enabled) => onChange({ ...settings, enabled })} />
    <button type="button" aria-label="OpenCode Go broker settings" title="Broker settings" onClick={onSettings}><Settings2 size={16} /></button>
  </>;
}

export function PluginSettings({ broker, onBrokerChange, brokerSettingsOpen, onBrokerSettingsOpen }: { broker: GoBrokerSettings; onBrokerChange: (settings: GoBrokerSettings) => void; brokerSettingsOpen: boolean; onBrokerSettingsOpen: (open: boolean) => void }) {
  return <div className="settings-section">
    <div className="section-title"><div><h2>Plugins</h2><p>App-wide extensions for all agents and conversations. Changes apply after saving, when each conversation is idle.</p></div></div>
    <section className="provider-group" aria-label="OpenCode Go key broker">
      <div className="provider-account provider-heading">
        <div><strong>OpenCode Go key broker</strong><small>Balance new conversations across available accounts while keeping existing conversations on the same account.</small></div>
        <div className="provider-account-actions"><BrokerControls settings={broker} onChange={onBrokerChange} onSettings={() => onBrokerSettingsOpen(!brokerSettingsOpen)} /></div>
      </div>
      {brokerSettingsOpen && <div className="provider-account provider-account-child">
        <div><strong>Automatic failover</strong><small>Retry another account if a request fails before output starts. A change of account may lose cached tokens.</small></div>
        <Toggle label="OpenCode Go broker automatic failover" checked={broker.failover} onChange={(failover) => onBrokerChange({ ...broker, failover })} />
      </div>}
    </section>
  </div>;
}
