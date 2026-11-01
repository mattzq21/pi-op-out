const key = Symbol.for('piop.runtime-events');

export function installBroker(t, answer) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value: async (name, data) => {
    if (name !== 'broker') throw new Error('Unexpected runtime event ' + name);
    const copy = value => JSON.parse(JSON.stringify(value ?? null));
    try { return { data: copy(await answer(data.path, copy(data.body))) }; }
    catch (error) { return { error: error.message, transient: false }; }
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key];
  });
}
