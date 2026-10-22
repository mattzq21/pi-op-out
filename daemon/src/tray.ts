import dbus from 'dbus-next';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DEVELOPMENT, PROJECT_DIR } from './config';
import * as daemonEndpoint from './daemon_endpoint';
import { errorText } from './util/sync';

const { Interface } = dbus.interface;
const { Variant } = dbus;

/** What started this daemon: a test (PIOP_DAEMON_ORIGIN=test), a debug build, or a release build. */
export function daemonOrigin(): 'test' | 'dev' | 'release' {
  if (process.env.PIOP_DAEMON_ORIGIN === 'test') return 'test';
  return DEVELOPMENT ? 'dev' : 'release';
}

function label(): string {
  const origin = daemonOrigin();
  const project = PROJECT_DIR ? ' · ' + join(basename(dirname(PROJECT_DIR)), basename(PROJECT_DIR)) : '';
  return origin + project;
}

const COLORS = { release: '#d46a24', dev: '#d7b84d', test: '#8f8b83' };

function icon(color: string): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="19" text-anchor="middle" font-family="serif" font-size="22" font-weight="700" fill="' + color + '">π</text></svg>';
}

class StatusNotifierItem extends Interface {
  constructor(private readonly title: string, private readonly themePath: string, private readonly iconName: string) { super('org.kde.StatusNotifierItem'); }
  get Category() { return 'ApplicationStatus'; }
  get Id() { return 'piop-daemon-' + process.pid; }
  get Title() { return this.title; }
  get Status() { return 'Active'; }
  get IconName() { return this.iconName; }
  get IconThemePath() { return this.themePath; }
  get ToolTip() { return ['', [], this.title, PROJECT_DIR]; }
  get Menu() { return '/MenuBar'; }
  get ItemIsMenu() { return true; }
  Activate(_x: number, _y: number) {}
  SecondaryActivate(_x: number, _y: number) {}
  ContextMenu(_x: number, _y: number) {}
  Scroll(_delta: number, _orientation: string) {}
}

StatusNotifierItem.configureMembers({
  properties: {
    Category: { signature: 's', access: 'read' }, Id: { signature: 's', access: 'read' }, Title: { signature: 's', access: 'read' },
    Status: { signature: 's', access: 'read' }, IconName: { signature: 's', access: 'read' }, IconThemePath: { signature: 's', access: 'read' },
    ToolTip: { signature: '(sa(iiay)ss)', access: 'read' }, Menu: { signature: 'o', access: 'read' }, ItemIsMenu: { signature: 'b', access: 'read' },
  },
  methods: {
    Activate: { inSignature: 'ii', outSignature: '' }, SecondaryActivate: { inSignature: 'ii', outSignature: '' },
    ContextMenu: { inSignature: 'ii', outSignature: '' }, Scroll: { inSignature: 'is', outSignature: '' },
  },
});

const QUIT = 2;

/** The menu: the daemon's origin as a disabled line, then Quit. */
class DBusMenu extends Interface {
  constructor(private readonly title: string, private readonly quit: () => void) { super('com.canonical.dbusmenu'); }
  get Version() { return 3; }
  get TextDirection() { return 'ltr'; }
  get Status() { return 'normal'; }
  get IconThemePath() { return []; }
  private item(id: number): Record<string, InstanceType<typeof Variant>> {
    if (id === 1) return { label: new Variant('s', this.title), enabled: new Variant('b', false) };
    if (id === QUIT) return { label: new Variant('s', 'Quit') };
    return { 'children-display': new Variant('s', 'submenu') };
  }
  GetLayout(_parent: number, _depth: number, _names: string[]) {
    const child = (id: number) => new Variant('(ia{sv}av)', [id, this.item(id), []]);
    return [1, [0, this.item(0), [child(1), child(QUIT)]]];
  }
  GetGroupProperties(ids: number[], _names: string[]) { return ids.map(id => [id, this.item(id)]); }
  GetProperty(id: number, name: string) { return this.item(id)[name] ?? new Variant('s', ''); }
  Event(id: number, event: string, _data: unknown, _time: number) { if (id === QUIT && event === 'clicked') this.quit(); }
  EventGroup(events: [number, string, unknown, number][]) { for (const [id, event, data, time] of events) this.Event(id, event, data, time); return []; }
  AboutToShow(_id: number) { return false; }
  AboutToShowGroup(_ids: number[]) { return [[], []]; }
}

DBusMenu.configureMembers({
  properties: {
    Version: { signature: 'u', access: 'read' }, TextDirection: { signature: 's', access: 'read' },
    Status: { signature: 's', access: 'read' }, IconThemePath: { signature: 'as', access: 'read' },
  },
  methods: {
    GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
    GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
    GetProperty: { inSignature: 'is', outSignature: 'v' },
    Event: { inSignature: 'isvu', outSignature: '' },
    EventGroup: { inSignature: 'a(isvu)', outSignature: 'ai' },
    AboutToShow: { inSignature: 'i', outSignature: 'b' },
    AboutToShowGroup: { inSignature: 'ai', outSignature: 'aiai' },
  },
  signals: { LayoutUpdated: { signature: 'ui' }, ItemsPropertiesUpdated: { signature: 'a(ia{sv})a(ias)' } },
});

/**
 * Shows this daemon in the desktop tray (StatusNotifierItem on the session bus): its origin and a Quit item.
 * Each daemon process owns its own bus name, so each daemon has its own icon. Without a session bus or tray host it reports why and runs on.
 * Returns the function that removes the icon.
 */
export async function startTray(quit: () => void): Promise<() => void> {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) { console.error('Tray icon not shown: no desktop session bus'); return () => {}; }
  const bus = dbus.sessionBus();
  bus.on('error', error => console.error('Tray icon failed: ' + errorText(error)));
  try {
    const title = label();
    const themePath = daemonEndpoint.directory();
    const iconName = 'piop-daemon-tray';
    writeFileSync(join(themePath, iconName + '.svg'), icon(COLORS[daemonOrigin()]), { mode: 0o600 });
    const name = 'org.kde.StatusNotifierItem-' + process.pid + '-1';
    await bus.requestName(name, 0);
    bus.export('/StatusNotifierItem', new StatusNotifierItem(title, themePath, iconName));
    bus.export('/MenuBar', new DBusMenu(title, quit));
    const register = async () => {
      const watcher = await bus.getProxyObject('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher');
      await watcher.getInterface('org.kde.StatusNotifierWatcher').RegisterStatusNotifierItem(name);
    };
    await register();
    // A restarted tray host forgets its items, so the icon registers again when the watcher comes back.
    const daemonBus = (await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')).getInterface('org.freedesktop.DBus');
    daemonBus.on('NameOwnerChanged', (owner: string, _old: string, current: string) => {
      if (owner === 'org.kde.StatusNotifierWatcher' && current) register().catch(error => console.error('Tray icon could not register again: ' + errorText(error)));
    });
  } catch (error) {
    console.error('Tray icon not shown: ' + errorText(error));
    bus.disconnect();
    return () => {};
  }
  return () => bus.disconnect();
}
