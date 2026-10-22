import { afterAll, expect, test } from 'bun:test';
import dbus from 'dbus-next';
import { startDaemon } from './harness';

const bus = dbus.sessionBus();
afterAll(() => bus.disconnect());

async function trayNames(): Promise<string[]> {
  const proxy = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  const names: string[] = await proxy.getInterface('org.freedesktop.DBus').ListNames();
  return names.filter(name => name.startsWith('org.kde.StatusNotifierItem-'));
}

test.skipIf(!process.env.DBUS_SESSION_BUS_ADDRESS)('each daemon shows its own tray icon with its origin, and Quit stops that daemon', async () => {
  const before = new Set(await trayNames());
  const first = await startDaemon();
  const second = await startDaemon();
  try {
    const menu = async (name: string) => (await bus.getProxyObject(name, '/MenuBar')).getInterface('com.canonical.dbusmenu');
    const labels = async (name: string) => { const [, layout] = await (await menu(name)).GetLayout(0, -1, []); return layout[2].map((child: any) => child.value[1].label?.value); };
    /** New tray icons of test daemons. Other programs may add icons at the same time. */
    const testIcons = async () => { const found: string[] = []; for (const name of (await trayNames()).filter(name => !before.has(name))) { try { if ((await labels(name))[0] === 'test') found.push(name); } catch {} } return found; };
    let added: string[] = [];
    for (let tries = 0; added.length < 2 && tries < 100; tries++, await Bun.sleep(100)) added = await testIcons();
    expect(added).toHaveLength(2);
    expect(await labels(added[0]!)).toEqual(['test', 'Quit']);
    await (await menu(added[0]!)).Event(2, 'clicked', new dbus.Variant('s', ''), 0);
    let left: string[] = added;
    for (let tries = 0; left.length > 1 && tries < 150; tries++, await Bun.sleep(100)) left = (await trayNames()).filter(name => added.includes(name));
    expect(left).toEqual([added[1]]);
  } finally { await first.dispose(); await second.dispose(); }
}, 60000);
