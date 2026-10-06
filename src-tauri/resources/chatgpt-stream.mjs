export function chatGptEvent(block) {
  let event = 'message';
  const data = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();

    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }

  if (!data.length || event === 'ping') return null;
  const text = data.join('\n');

  return { event, data: text === '[DONE]' ? text : JSON.parse(text) };
}

export async function* chatGptEvents(response, signal) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('ChatGPT returned an unexpected stream format.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      signal.throwIfAborted();
      let timer;

      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ChatGPT stream timed out.')), 60000); }),
      ]).finally(() => clearTimeout(timer));

      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary;

      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = chatGptEvent(block);

        if (event) yield event;
      }

      if (buffer.length > 8 * 1024 * 1024) throw new Error('ChatGPT stream event is too large.');

      if (chunk.done) break;
    }

    if (buffer.trim()) { const event = chatGptEvent(buffer);

    if (event) yield event; }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function chatGptPath(path) {
  if (path === '') return [];
  const parts = path.replace(/^\//, '').split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));

  if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Invalid ChatGPT delta path.');

  return parts;
}

function chatGptAppend(previous, value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate dynamic ChatGPT wire values at the protocol boundary.
  if (typeof previous === 'string') return previous + value;

  if (Array.isArray(previous)) return previous.concat(value);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate dynamic ChatGPT wire values at the protocol boundary.
  if (previous && typeof previous === 'object') return { ...previous, ...value };

  return value;
}

function chatGptOperation(parent, key, delta) {
  const value = delta.v;

  switch (delta.o) {
    case 'patch': for (const nested of value) parent[key] = chatGptPatch(parent[key], nested); break;
    case 'add': chatGptAdd(parent, key, value); break;
    case 'remove': if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; break;
    case 'replace': parent[key] = value; break;
    case 'append': parent[key] = chatGptAppend(parent[key], value); break;
    case 'truncate': if (parent[key]) parent[key] = parent[key].slice(0, value); break;
    default: throw new Error('Unknown ChatGPT delta operation.');
  }
}

function chatGptAdd(parent, key, value) {
  if (Array.isArray(parent)) parent.splice(Number(key), 0, value);
  else parent[key] = value;
}

function chatGptPatch(root, delta) {
  const wrapper = { root };
  const parts = ['root', ...chatGptPath(delta.p ?? '')];
  let parent = wrapper;

  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index];
    parent[key] ??= /^\d+$/.test(parts[index + 1]) ? [] : {};
    parent = parent[key];
  }

  chatGptOperation(parent, parts.at(-1), delta);

  return wrapper.root;
}

export function chatGptDecoder() {
  const channels = new Map();
  let previous = { c: 0, p: '', o: 'add' };
  let encoding;

  return event => {
    if (event.event === 'delta_encoding') {
      encoding = event.data;

      if (encoding !== 'v1') throw new Error('Unsupported ChatGPT delta encoding.');
      channels.clear(); previous = { c: 0, p: '', o: 'add' };

      return null;
    }

    if (event.event !== 'delta') return event.data;

    if (encoding !== 'v1') throw new Error('ChatGPT delta arrived without its encoding.');
    const delta = { c: previous.c, p: previous.p, o: previous.o, ...event.data };
    previous = delta;
    const value = chatGptPatch(channels.get(delta.c), delta);
    channels.set(delta.c, value);

    return value;
  };
}

export async function chatGptSocket(url, topic, signal, receive) {
  if (typeof WebSocket === 'undefined') throw new Error('ChatGPT streaming requires Node 22 or newer on this host.');
  const target = new URL(url);

  if (target.protocol !== 'wss:' || !['chatgpt.com', 'openai.com'].some(domain => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) throw new Error('Invalid ChatGPT stream address.');
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const seen = new Set();
    let timer;
    let finished = false;

    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); socket.close();

      if (error) reject(error); else resolve();
    };

    const abort = () => finish(signal.reason);
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('ChatGPT stream timed out.')), 60000); };

    const payload = message => {
      if (finished || message?.type !== 'conversation-turn-stream') return;
      touch();

      if (message.payload.type === 'done') { finish();

      return; }

      if (message.payload.type !== 'stream-item') return;
      const item = message.payload;

      if (!chatGptSocketItem(seen, item)) return;
      const event = chatGptEvent(item.encoded_item);

      if (event) receive(event);
    };

    socket.addEventListener('open', () => socket.send(JSON.stringify([
      { id: 1, command: { type: 'connect', presence: { type: 'presence', state: 'foreground' } } },
      { id: 2, command: { type: 'subscribe', topic_id: topic, offset: '0' } },
    ])));
    socket.addEventListener('message', event => {
      try {
        const frames = JSON.parse(event.data);

        if (!Array.isArray(frames)) return;

        for (const frame of frames) {
          if (finished) break;
          chatGptSocketFrame(frame, topic, payload);
        }
      } catch (error) { finish(error); }
    });
    socket.addEventListener('error', () => finish(new Error('ChatGPT stream connection failed.')));
    socket.addEventListener('close', () => finish(new Error('ChatGPT stream closed before completion.')));
    signal.addEventListener('abort', abort, { once: true }); touch();
  });
}

function chatGptSocketFrame(frame, topic, payload) {
  if (frame.id === 2) {
    if (frame.reply?.recovered === false) throw new Error('ChatGPT stream history could not be recovered.');

    for (const item of frame.reply?.catchups ?? []) payload(item.payload);
  }

  if (frame.topic_id === topic) payload(frame.payload);
}

function chatGptSocketItem(seen, item) {
  if (item.stream_item_id && seen.has(item.stream_item_id)) return false;

  if (item.parent_stream_item_id != null && !seen.has(item.parent_stream_item_id)) throw new Error('ChatGPT stream missed an item.');

  if (item.stream_item_id) seen.add(item.stream_item_id);

  return true;
}
