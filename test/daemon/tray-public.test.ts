import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import dbus from 'dbus-next';
import { startDaemon, type TestDaemon } from './harness';

const { Interface } = dbus.interface;

class TrayHost extends Interface {
  readonly names: string[] = [];
  readonly ready = Promise.withResolvers<void>();
  constructor() { super('org.kde.StatusNotifierWatcher'); }
  RegisterStatusNotifierItem(name: string) {
    this.names.push(name);
    if (this.names.length === 2) this.ready.resolve();
  }
}
TrayHost.configureMembers({ methods: { RegisterStatusNotifierItem: { inSignature: 's', outSignature: '' } } });

test('each daemon shows its own tray icon with its origin, and Quit stops that daemon', async () => {
  const server = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let bus: ReturnType<typeof dbus.sessionBus> | undefined;
  const daemons: TestDaemon[] = [];
  try {
    const [address] = await once(server.stdout!, 'data');
    const busAddress = address.toString().trim();
    bus = dbus.sessionBus({ busAddress });
    const watcher = new TrayHost();
    bus.export('/StatusNotifierWatcher', watcher);
    await bus.requestName('org.kde.StatusNotifierWatcher', 0);
    for (let index = 0; index < 2; index++) daemons.push(await startDaemon({ env: { DBUS_SESSION_BUS_ADDRESS: busAddress } }));
    await watcher.ready.promise;
    expect(new Set(watcher.names).size).toBe(2);
    const menu = async (name: string) => (await bus!.getProxyObject(name, '/MenuBar')).getInterface('com.canonical.dbusmenu');
    for (const name of watcher.names) {
      const [, layout] = await (await menu(name)).GetLayout(0, -1, []);
      expect(layout[2].map((child: any) => child.value[1].label?.value)).toEqual(['test', 'Quit']);
    }
    const registry = (await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')).getInterface('org.freedesktop.DBus');
    const gone = Promise.withResolvers<void>();
    registry.on('NameOwnerChanged', (name: string, _old: string, owner: string) => {
      if (name === watcher.names[0] && !owner) gone.resolve();
    });
    await (await menu(watcher.names[0]!)).Event(2, 'clicked', new dbus.Variant('s', ''), 0);
    await gone.promise;
    const names: string[] = await registry.ListNames();
    expect(names.filter(name => watcher.names.includes(name))).toEqual([watcher.names[1]!]);
  } finally {
    await Promise.all(daemons.map(daemon => daemon.dispose()));
    bus?.disconnect();
    const ended = once(server, 'exit');
    server.kill();
    await ended;
  }
}, 60000);
