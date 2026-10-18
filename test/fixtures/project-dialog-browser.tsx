import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { ProjectDialog } from '../../clients/ui/components/ProjectDialog';
import '../../clients/ui/styles.css';

const failure = new URLSearchParams(location.search).get('failure');
const [visible, setVisible] = createSignal(true);
const [cancelled, setCancelled] = createSignal(0);
const [delivered, setDelivered] = createSignal(0);
const [settledHomes, setSettledHomes] = createSignal(0);
const [opened, setOpened] = createSignal<unknown[]>([]);
const settleHome = (home: Promise<string>) => { void home.finally(() => setTimeout(() => setSettledHomes(value => value + 1))).catch(() => {}); return home; };
render(() => <>
  <output aria-label="Cancelled dialogs">{cancelled()}</output>
  <output aria-label="Delivered listings">{delivered()}</output>
  <output aria-label="Settled home requests">{settledHomes()}</output>
  <output aria-label="Opened folders">{JSON.stringify(opened())}</output>
  <Show when={visible()}>
    <ProjectDialog initialPath={new URLSearchParams(location.search).get('path') ?? ''} hostId="local" hosts={[{ id: "local", name: "Local" }, { id: "remote", name: "Remote" }]}
      onHomeDirectory={host => settleHome(failure === "home" ? Promise.reject(new Error("home unavailable")) : window.projectHome(host))}
      onChooseDirectory={async (path, host) => { if (failure === "listing") { if (path.endsWith("/alpha/")) throw "listing failed"; return null; } const result = await window.listProjectFolders(path, host); setDelivered(value => value + 1); return result; }}
      onOpen={async (...args) => { setOpened(values => [...values, args]); await window.openProject(...args); }}
      onCancel={() => { setCancelled(value => value + 1); setVisible(false); }} />
  </Show>
</>, document.getElementById('root')!);
