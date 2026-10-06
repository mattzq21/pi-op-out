function xor(text, key) {
  return Array.from(text, (character, index) => String.fromCharCode(character.charCodeAt(0) ^ key.charCodeAt(index % key.length))).join('');
}

function challengeVm(dx, token) {
  const values = new Map();
  let operations = 0;
  let settled = false;
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const complete = value => { if (!settled) { settled = true; resolve(value); } };

  const failed = value => { if (!settled) { settled = true; reject(value); } };

  const run = async () => {
    while (!settled && values.get(9).length) {
      if (++operations > 20000) throw new Error('Verification operation limit');
      const [instruction, ...args] = values.get(9).shift();
      await values.get(instruction)?.(...args);
    }
  };

  const invoke = (fn, args) => values.get(fn)(...args.map(key => values.get(key)));
  values.set(0, data => challengeVm(data, String(values.get(16))));
  values.set(1, (target, key) => values.set(target, xor(String(values.get(target)), String(values.get(key)))));
  values.set(2, (key, value) => values.set(key, value));
  values.set(3, value => complete(btoa(String(value))));
  values.set(4, value => failed(btoa(String(value))));
  values.set(5, (target, source) => {
    const value = values.get(target);

    if (Array.isArray(value)) value.push(values.get(source)); else values.set(target, value + values.get(source));
  });
  values.set(6, (target, object, key) => values.set(target, values.get(object)[String(values.get(key))]));
  values.set(7, (fn, ...args) => invoke(fn, args));
  values.set(8, (target, source) => values.set(target, values.get(source)));
  values.set(10, window);
  values.set(11, (target, pattern) => values.set(target, Array.from(document.scripts).map(script => script.src.match(String(values.get(pattern)))).find(Boolean)?.[0] ?? null));
  values.set(12, target => values.set(target, values));
  values.set(13, (target, fn, ...args) => { try { values.get(fn)(...args); } catch (error) { values.set(target, String(error)); } });
  values.set(14, (target, source) => values.set(target, JSON.parse(String(values.get(source)))));
  values.set(15, (target, source) => values.set(target, JSON.stringify(values.get(source))));
  values.set(16, token);
  values.set(17, async (target, fn, ...args) => { try { values.set(target, await invoke(fn, args)); } catch (error) { values.set(target, String(error)); } });
  values.set(18, target => values.set(target, atob(String(values.get(target)))));
  values.set(19, target => values.set(target, btoa(String(values.get(target)))));
  values.set(20, (a, b, fn, ...args) => values.get(a) === values.get(b) ? values.get(fn)(...args) : null);
  values.set(21, (a, b, limit, fn, ...args) => Math.abs(Number(values.get(a)) - Number(values.get(b))) > Number(values.get(limit)) ? values.get(fn)(...args) : null);
  values.set(22, async (target, queue) => {
    const previous = [...values.get(9)]; values.set(9, [...queue]);

    try { await run(); } catch (error) { values.set(target, String(error)); } finally { values.set(9, previous); }
  });
  values.set(23, (target, fn, ...args) => values.get(target) === undefined ? null : values.get(fn)(...args));
  values.set(24, (target, object, key) => values.set(target, values.get(object)[String(values.get(key))].bind(values.get(object))));

  for (const id of [25, 26, 28]) values.set(id, () => undefined);
  values.set(27, (target, source) => {
    const value = values.get(target);

    if (Array.isArray(value)) value.splice(value.indexOf(values.get(source)), 1); else values.set(target, value - values.get(source));
  });
  values.set(29, (target, a, b) => values.set(target, Number(values.get(a)) < Number(values.get(b))));
  values.set(30, (target, output, params, body) => values.set(target, async (...args) => {
    if (settled) return;
    const previous = [...values.get(9)];

    if (Array.isArray(body)) params.forEach((key, index) => values.set(key, args[index]));
    values.set(9, [...(body ?? params ?? [])]);

    try { await run();

    return values.get(output); } finally { values.set(9, previous); }
  }));
  values.set(33, (target, a, b) => values.set(target, Number(values.get(a)) * Number(values.get(b))));
  values.set(34, async (target, source) => values.set(target, await values.get(source)));
  values.set(35, (target, a, b) => values.set(target, Number(values.get(b)) === 0 ? 0 : Number(values.get(a)) / Number(values.get(b))));
  const timer = setTimeout(() => complete(String(operations)), 500);

  try {
    values.set(9, JSON.parse(xor(atob(dx), token)));
    void run().catch(error => complete(btoa(`${operations}: ${String(error)}`)));
  } catch (error) { complete(btoa(`${operations}: ${String(error)}`)); }

  return result.finally(() => clearTimeout(timer));
}

window.addEventListener('message', async event => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate dynamic ChatGPT wire values at the protocol boundary.
  if (event.source !== parent || typeof event.data?.dx !== 'string' || typeof event.data?.token !== 'string') return;

  try { parent.postMessage({ nonce: event.data.nonce, result: await challengeVm(event.data.dx, event.data.token) }, '*'); }
  catch { parent.postMessage({ nonce: event.data.nonce, failed: true }, '*'); }
}, { once: true });
