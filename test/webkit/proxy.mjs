import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { WebSocketServer, WebSocket } from 'ws';
import { injectedScriptSource, playwrightInternals } from './sources.mjs';

let certificate;

export function urlMatcher(match) {
  if (typeof match === 'function') return url => match(new URL(url));
  if (match instanceof RegExp) return url => match.test(url);
  const pattern = new RegExp(playwrightInternals.iso.globToRegexPattern(match));
  return url => pattern.test(url);
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const corsHeaders = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST' };

export async function startProxy(host) {
  const sockets = new Set();
  const webSockets = new WebSocketServer({ noServer: true });
  let claim;

  const respond = async (request, response, url) => {
    if (url.pathname.startsWith('/__pw/')) {
      if (request.method === 'OPTIONS') { response.writeHead(204, corsHeaders); response.end(); return; }
      const kind = url.pathname.slice('/__pw/'.length);
      if (kind === 'injected.js') { response.writeHead(200, { 'content-type': 'text/javascript', ...corsHeaders }); response.end(injectedScriptSource); return; }
      const body = JSON.parse((await readBody(request)).toString() || '{}');
      const answer = await host.onBridge(kind, body);
      response.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      response.end(JSON.stringify(answer ?? {}));
      return;
    }
    const postData = await readBody(request);
    for (const route of host.routes()) {
      if (!route.matches(url.href)) continue;
      const outcome = await route.handle({ url: url.href, method: request.method, headers: request.headers, postData });
      if (outcome.type === 'fallback') continue;
      if (outcome.type === 'abort') { request.socket.destroy(); return; }
      if (outcome.type === 'fulfill') { await send(request, response, outcome.status, outcome.headers, outcome.body); return; }
      return forward(request, response, outcome.url ? new URL(outcome.url) : url, outcome.headers ?? request.headers, postData);
    }
    return forward(request, response, url, request.headers, postData);
  };

  const send = async (request, response, status, headers, body) => {
    const type = String(headers['content-type'] ?? '');
    if (/text\/html/i.test(type) && request.method === 'GET') {
      const pageId = claim; claim = undefined;
      const script = '<script>' + host.bridgeScript(pageId).replace(/<\/script/gi, '<\\/script') + '</script>';
      const html = body.toString('utf8');
      const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
      body = Buffer.from(doctype ? doctype[0] + script + html.slice(doctype[0].length) : script + html);
      headers = { ...headers, 'content-length': String(body.length), 'cache-control': 'no-store' };
      delete headers['content-encoding'];
    }
    response.writeHead(status, headers);
    response.end(body);
  };

  const forward = (request, response, url, headers, postData) => new Promise(resolve => {
    const outgoing = { ...headers, host: url.host };
    delete outgoing['accept-encoding'];
    delete outgoing['proxy-connection'];
    const client = (url.protocol === 'https:' ? https : http).request(url, { method: request.method, headers: outgoing, rejectUnauthorized: false }, async upstream => {
      try { await send(request, response, upstream.statusCode ?? 502, { ...upstream.headers }, await readBody(upstream)); }
      catch { response.destroy(); }
      resolve();
    });
    client.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('The test proxy could not reach ' + url.href + ': ' + error.message);
      resolve();
    });
    client.end(postData);
  });

  const handler = scheme => (request, response) => {
    const url = new URL(/^[a-z]+:\/\//.test(request.url) ? request.url : scheme + '://' + request.headers.host + request.url);
    respond(request, response, url).catch(error => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error?.stack ?? error));
    });
  };

  const upgrade = scheme => (request, socket, head) => {
    const url = new URL(/^[a-z]+:\/\//.test(request.url) ? request.url.replace(/^http/, 'ws') : scheme + '://' + request.headers.host + request.url);
    const route = host.webSocketRoutes().find(candidate => candidate.matches(url.href));
    if (route) { webSockets.handleUpgrade(request, socket, head, client => route.handle(client, url.href)); return; }
    webSockets.handleUpgrade(request, socket, head, client => {
      const server = new WebSocket(url.href, { rejectUnauthorized: false });
      const pending = [];
      server.on('open', () => { for (const message of pending.splice(0)) server.send(message.data, { binary: message.binary }); });
      server.on('message', (data, binary) => client.send(data, { binary }));
      client.on('message', (data, binary) => server.readyState === WebSocket.OPEN ? server.send(data, { binary }) : pending.push({ data, binary }));
      server.on('close', () => client.close());
      client.on('close', () => server.close());
      server.on('error', () => client.close());
    });
  };

  const secure = http.createServer(handler('https'));
  secure.on('upgrade', upgrade('wss'));
  const proxy = http.createServer(handler('http'));
  proxy.on('upgrade', upgrade('ws'));
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (request, socket, head) => {
    certificate ??= playwrightInternals.utils.generateSelfSignedCertificate();
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const port = Number(request.url.split(':').pop());
    if (port === 80) { if (head.length) socket.unshift(head); proxy.emit('connection', socket); return; }
    const secured = new tls.TLSSocket(socket, { isServer: true, cert: certificate.cert, key: certificate.key });
    if (head.length) socket.unshift(head);
    sockets.add(secured);
    secured.on('close', () => sockets.delete(secured));
    secure.emit('connection', secured);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

  return {
    url: 'http://127.0.0.1:' + proxy.address().port,
    claim(pageId) { claim = pageId; },
    async close() {
      for (const socket of sockets) socket.destroy();
      webSockets.close();
      await new Promise(resolve => proxy.close(resolve));
    },
  };
}
