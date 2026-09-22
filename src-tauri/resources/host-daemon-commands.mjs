function sessionSpec(spec, flag, value) {
  const args = [];
  for (let index = 0; index < spec.args.length; index++) {
    if (['--session', '--session-id', '--fork'].includes(spec.args[index])) { index++; continue; }
    if (spec.args[index] === '--no-session') continue;
    args.push(spec.args[index]);
  }
  return { ...spec, args: [...args, flag, value] };
}

function rememberAttachment(runtimeId, session) {
  const spec = session.ephemeral ? session.spec : sessionSpec(session.spec, '--session-id', session.state?.sessionId || session.identity);
  attachments.set(runtimeId, { ...attachments.get(runtimeId), spec, sessionKey: session.identity, cwd: session.cwd });
}

function workerLaunch(spec, identity) {
  if (!spec.env?.PIOP_REMOTE_SESSION_CLAIMS) return spec;
  const directory = join(homedir(), spec.env.PIOP_REMOTE_SESSION_CLAIMS, 'session-claims');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 40);
  return { program: 'flock', args: ['--nonblock', '--no-fork', join(directory, `id-${hash}.lock`), spec.program, ...spec.args] };
}

async function sessionIdentity(spec, fallback) {
  const index = spec.args.lastIndexOf('--session');
  if (index < 0) {
    const idIndex = spec.args.lastIndexOf('--session-id');
    return idIndex < 0 ? fallback : spec.args[idIndex + 1];
  }
  const file = await open(spec.args[index + 1], 'r').catch((error) => { if (error.code === 'ENOENT') throw new Error('This conversation has been deleted or archived'); throw error; });
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer);
    const id = JSON.parse(buffer.subarray(0, bytesRead).toString().split('\n')[0]).id;
    if (typeof id !== 'string' || !id) throw new Error('Missing session identity');
    return id;
  } finally { await file.close(); }
}

async function forkSession(session, runtimeId, command, state) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-branch-'));
  let worker, next, pendingPath, ownershipGuard;
  let pendingCreated = false;
  let committed = false;
  try {
    const spec = sessionSpec(session.spec, '--fork', state.sessionFile);
    spec.args.push('--session-dir', directory);
    worker = new Session(randomUUID(), spec, session.timeout, session.ephemeral, true, session.clientId);
    worker.cwd = session.cwd; sessions.set(worker.key, worker);
    const initial = await worker.execute({ type: 'get_state' });
    const result = await worker.raw(command);
    if (result?.cancelled) return result;
    const branch = await worker.execute({ type: 'get_state' });
    await worker.stop();
    validatePreparedBranch(branch, initial, state, directory);
    const { content, newline, header } = await readPreparedBranch(branch);
    const destination = join(dirname(state.sessionFile), basename(branch.sessionFile));
    pendingPath = join(dirname(state.sessionFile), `.piop-branch-${randomUUID()}.pending`);
    const output = await open(pendingPath, 'wx', 0o600); pendingCreated = true;
    try {
      await output.writeFile(JSON.stringify({ ...header, parentSession: state.sessionFile }) + '\n');
      await output.writeFile(content.subarray(newline + 1));
    } finally { await output.close(); }
    await link(pendingPath, destination);
    ownershipGuard = session.ephemeral ? { owned: true, release: async () => { } } : await ownership.begin(branch.sessionId, session.clientId, { path: destination });
    if (!ownershipGuard.owned) throw ownershipError();
    next = new Session(branch.sessionId, sessionSpec(session.spec, '--session', destination), session.timeout, session.ephemeral, true, session.clientId);
    next.cwd = session.cwd; next.reservedPath = destination; sessions.set(next.key, next);
    const opened = await next.execute({ type: 'get_state' });
    if (opened.sessionId !== branch.sessionId || opened.sessionFile !== destination) throw new Error('Pi did not open the prepared branch');
    if (subscriptions.get(runtimeId) !== session) throw new Error('The conversation changed while preparing its branch');
    const presence = session.views.get(runtimeId);
    const detached = session.detach(runtimeId);
    next.reservedPath = undefined; next.transient = false; next.attach(runtimeId, presence); committed = true;
    rememberAttachment(runtimeId, next);
    await detached;
    void next.reconcileConfiguration(true);
    if (subscriptions.get(runtimeId) === next) next.publish({ type: 'session_switched' }, runtimeId);
    return result;
  } finally {
    await cleanupBranch(ownershipGuard, worker, next, committed, pendingCreated, pendingPath, directory);
  }
}

async function handleVoice(packet) {
  return hostVoice.handle(packet);
}

async function handleOwnershipDrained(packet) {

  const pending = ownershipDrains.get(packet.requestId);
  if (pending) { ownershipDrains.delete(packet.requestId); if (packet.error) pending.reject(new Error(packet.error)); else pending.resolve(); }
  return;
}

async function handleConversationMutation(packet) {

  const guard = await ownership.begin(packet.sessionId, packet.clientId, { mutation: packet.operation !== 'save_diffs', message: packet.operation === 'message', archive: packet.operation === 'archive', path: packet.sessionPath, archived: packet.archived });
  if (!guard.owned) throw ownershipError();
  const token = randomUUID(); ownership.guards.set(token, { ...guard, operation: packet.operation });
  return { token };
}

async function handleConversationMutationEnd(packet) {

  const guard = ownership.guards.get(packet.token);
  if (guard) { ownership.guards.delete(packet.token); await guard.release(packet.success && ['delete', 'archive'].includes(guard.operation)); }
  return;
}

async function handleProviderAuth(packet) {

  if (!providerAuth) throw new Error('Provider authentication is unavailable. Restart Piop.');
  return providerAuth.handle(packet.owner, packet.request);
}

async function handleProviderAuthCancelOwner(packet) {
  providerAuth?.cancelOwner(packet.owner); return;
}

async function handleConfigure(packet) {

  const configuration = packet.configuration;
  if (!configuration || !Number.isSafeInteger(configuration.agentRevision) || configuration.agentRevision < 0 || !configuration.settings || typeof configuration.autoCompaction !== 'boolean' || typeof configuration.autoRetry !== 'boolean') throw new Error('Invalid daemon configuration');
  if (JSON.stringify(canonicalSettings(configuration)) !== JSON.stringify(canonicalSettings(desiredConfiguration))) desiredConfiguration = configuration;
  for (const session of sessions.values()) {
    session.publish({ type: 'settings_pending', pending: session.settingsPending() });
    void session.reconcileConfiguration(true);
  }
  return;
}

async function handleAttach(packet) {
  const { runtimeId } = packet;
  attachments.set(runtimeId, packet);
  const stillAttached = () => attachments.get(runtimeId) === packet;
  const identity = await sessionIdentity(packet.spec, packet.sessionKey);
  if (!stillAttached()) throw new Error('The conversation was closed while attaching');
  const pathIndex = packet.spec.args.lastIndexOf('--session');
  const path = pathIndex < 0 ? undefined : packet.spec.args[pathIndex + 1];
  const guard = packet.ephemeral ? { owned: true, release: async () => { } } : await ownership.begin(identity, packet.clientId, { take: packet.takeOwnership, path, create: !path });
  let session;
  try {
    if (!stillAttached()) throw new Error('The conversation was closed while attaching');
    if (!guard.owned) { readonlyViews.set(runtimeId, { id: identity, path }); return { attached: true, owned: false }; }
    session = await attachedSession(packet, guard, identity);
    await session.execute({ type: 'get_state' });
    if (!stillAttached()) throw new Error('The conversation was closed while attaching');
    readonlyViews.delete(runtimeId);
    session.attach(runtimeId, packet.presence);
    rememberAttachment(runtimeId, session);
    void session.reconcileConfiguration(true);
    return { attached: session.views.size > 1 || session.submitted, owned: true };
  } finally {
    await guard.release?.();
    if (!stillAttached() && session && !session.views.size) {
      if (!session.submitted && !session.working) await session.stop();
      else await session.releaseUnusedOwnership();
    }
    if (!stillAttached() && guard.owned && !session) {
      await ownership.releaseClient(identity, packet.clientId, () => ![...attachments.values()].some((value) => value.clientId === packet.clientId && value.sessionKey === packet.sessionKey));
    }
  }
}

async function handleShutdown(packet) {
  await hostVoice.shutdown(); providerAuth?.shutdown(); await Promise.all([...sessions.values()].map((session) => session.stop())); process.exit(0);
}

async function handleRetire(packet) {

  const session = sessions.get(packet.sessionKey) ?? [...sessions.values()].find((session) => session.state?.sessionFile === packet.sessionPath || session.reservedPath === packet.sessionPath);
  if (!session) return;
  await session.retire(); return;
}

async function handleSessionCommand(packet) {

  const session = sessions.get(packet.sessionKey);
  if (!session) throw new Error('Conversation is no longer running');
  return session.execute(packet.command);
}

async function readSavedConversation(target, command) {
  if (command.type === 'get_session_revision') return ownership.revision(target.id, target.path);
  const snapshot = await ownership.snapshot(target.id, target.path);
  const readers = {
    get_snapshot: () => snapshot,
    get_entries: () => snapshot.history,
    get_state: () => snapshot.state,
    get_tool_payload: () => toolPayloadPage(savedToolPayload(snapshot.history.entries, command.toolCallId), command),
  };
  return readers[command.type]();
}

async function handleReadonly(packet) {
  const { runtimeId, type } = packet;
  const target = readonlyViews.get(runtimeId);
  if (type === 'detach') { readonlyViews.delete(runtimeId); attachments.delete(runtimeId); return { stopped: false }; }
  if (type === 'presence') return;
  const live = [...sessions.values()].find((session) => session.identity === target.id && !session.closed && !session.transient);
  if (['get_snapshot', 'get_entries', 'get_state', 'get_session_revision', 'get_tool_payload'].includes(packet.command?.type)) {
    return live ? live.execute(packet.command) : readSavedConversation(target, packet.command);
  }
  throw ownershipError();
}

async function executeSessionCommand(session, runtimeId, command) {
  if (command.type === 'extension_ui_response') {
    const dialog = session.dialogs.get(command.id);
    if (!dialog || dialog.owner !== runtimeId) return;
    session.resolveDialog(command.id);
    session.child.stdin.write(JSON.stringify(command) + '\n');
    return;
  }
  if (!command.type.startsWith('get_') || command.type === 'get_snapshot') await session.reconcileConfiguration();
  if (!command.type.startsWith('get_') && session.configurationFailed && session.settingsPending()) throw new Error(session.configurationError);
  if (['fork', 'fork_after', 'clone', 'new_session', 'switch_session'].includes(command.type)) return switchConversation(session, runtimeId, command);
  return queueSessionCommand(session, command);
}

async function switchConversation(session, runtimeId, command) {
  if (session.working || session.queue.pendingMessages.length) throw new Error('Stop or pause the response and finish queued messages before branching or switching');
  const state = await session.execute({ type: 'get_state' });
  if (subscriptions.get(runtimeId) !== session) throw new Error('The conversation changed while preparing its destination');
  if (command.type === 'fork' || command.type === 'fork_after') {
    if (!state.sessionFile) throw new Error('The conversation has no session file');
    return forkSession(session, runtimeId, command, state);
  }
  const { key, value, destinationSpec, destinationGuard } = await prepareDestination(session, command, state);
  if (!destinationGuard.owned) {
    attachments.set(runtimeId, { ...attachments.get(runtimeId), spec: destinationSpec, sessionKey: key });
    readonlyViews.set(runtimeId, { id: key, path: value });
    session.publish({ type: 'ownership_lost' }, runtimeId);
    await session.detach(runtimeId);
    return {};
  }
  try {
    return await openDestination(session, runtimeId, command, key, destinationSpec);
  } finally { await destinationGuard.release(); }
}

function validatePreparedBranch(branch, initial, state, directory) {
  if (!branch.sessionFile || dirname(resolve(branch.sessionFile)) !== resolve(directory) || branch.sessionFile === initial.sessionFile || !branch.sessionId || branch.sessionId === state.sessionId || sessions.has(branch.sessionId)) throw new Error('Pi did not create the requested branch');
}

async function readPreparedBranch(branch) {
  const content = await readFile(branch.sessionFile);
  const newline = content.indexOf(10);
  if (newline < 0) throw new Error('The branch has no session header');
  const header = JSON.parse(content.subarray(0, newline).toString());
  if (header.type !== 'session' || header.id !== branch.sessionId) throw new Error('The branch has an invalid session identity');
  return { content, newline, header };
}

async function cleanupBranch(ownershipGuard, worker, next, committed, pendingCreated, pendingPath, directory) {
  await ownershipGuard?.release?.();
  try {
    if (worker) await worker.stop();
    if (!committed && next) await next.stop();
    // A published branch may already have been opened by another backend.
  } finally {
    try { if (pendingCreated) await rm(pendingPath, { force: true }); }
    finally {
      try { await rm(directory, { recursive: true, force: true }); }
      finally {
        forgetBranchWorker(worker);
        if (!committed) forgetBranchWorker(next);
      }
    }
  }
}

function forgetBranchWorker(worker) {
  if (worker && sessions.get(worker.key) === worker) sessions.delete(worker.key);
}

function attachedSpec(packet, cwd) {
  return packet.spec.env?.PIOP_REMOTE_SESSION_CLAIMS
    ? { ...packet.spec, env: { ...packet.spec.env, PIOP_SESSION_CWD: cwd || '~' } }
    : { ...packet.spec, cwd: cwd || packet.spec.cwd };
}

function expandSessionHome(cwd) {
  return cwd === "~" ? homedir() : cwd?.startsWith("~/") ? join(homedir(), cwd.slice(2)) : cwd;
}

async function attachedSession(packet, guard, identity) {
  const requestedCwd = guard.saved?.header.cwd || packet.cwd;
  const cwd = expandSessionHome(requestedCwd);
  const spec = attachedSpec(packet, cwd);
  const findSession = () => [...sessions.values()].find((candidate) => candidate.identity === identity && !candidate.closed);
  let session = findSession();
  if (session?.transient) throw new Error('This conversation branch is still being prepared');
  if (session?.stopPromise) { await session.stopPromise; session = findSession(); }
  if (!session || session.closed) {
    session = new Session(identity, spec, packet.timeout, packet.ephemeral, false, packet.clientId);
    session.cwd = cwd;
    sessions.set(identity, session);
  }
  return session;
}

async function prepareDestination(session, command, state) {
  let key = randomUUID();
  const flag = command.type === 'new_session' ? '--session-id' : command.type === 'switch_session' ? '--session' : '--fork';
  const value = command.type === 'new_session' ? key : command.type === 'switch_session' ? command.sessionPath : state.sessionFile;
  if (!value) throw new Error('The conversation has no session file');
  if (command.type === 'switch_session') key = await sessionIdentity(sessionSpec(session.spec, flag, value), key);
  const destinationSpec = sessionSpec(session.spec, flag, value);
  const destinationGuard = session.ephemeral ? { owned: true, release: async () => { } } : await ownership.begin(key, session.clientId, { path: command.type === 'switch_session' ? value : undefined, create: command.type !== 'switch_session' });
  return { key, value, destinationSpec, destinationGuard };
}

async function openDestination(session, runtimeId, command, key, destinationSpec) {
  let next = command.type === 'switch_session' ? [...sessions.values()].find((candidate) => !candidate.closed && candidate.identity === key) : undefined;
  if (next?.transient) throw new Error('This conversation branch is still being prepared');
  const created = !next;
  if (!next) { next = new Session(key, destinationSpec, session.timeout, session.ephemeral, false, session.clientId); next.cwd = session.cwd; sessions.set(key, next); }
  try {
    return await transferDestination(session, next, runtimeId);
  } catch (error) { if (created && !next.views.size && !next.submitted && !next.working) await next.stop(); throw error; }
}

async function transferDestination(session, next, runtimeId) {
  const result = {};
  await next.execute({ type: 'get_state' });
  if (subscriptions.get(runtimeId) !== session) throw new Error('The conversation changed while preparing its destination');
  if (next.closed || next.stopPromise) throw new Error('The destination conversation has stopped');
  if (next !== session) {
    const presence = session.views.get(runtimeId);
    // Transfer synchronously so a close cannot land between detach and attach.
    const detached = session.detach(runtimeId); next.attach(runtimeId, presence);
    await detached;
  }
  void next.reconcileConfiguration(true);
  rememberAttachment(runtimeId, next);
  if (subscriptions.get(runtimeId) === next) next.publish({ type: 'session_switched' }, runtimeId);
  return result;
}

async function handle(packet) {
  const { runtimeId, type } = packet;
  if (type === 'detach') attachments.delete(runtimeId);
  const handlers = { "voice": handleVoice, "ownership_drained": handleOwnershipDrained, "conversation_mutation": handleConversationMutation, "conversation_mutation_end": handleConversationMutationEnd, "provider_auth": handleProviderAuth, "provider_auth_cancel_owner": handleProviderAuthCancelOwner, "configure": handleConfigure, "attach": handleAttach, "shutdown": handleShutdown, "retire": handleRetire, "session_command": handleSessionCommand };
  if (Object.hasOwn(handlers, type)) return handlers[type](packet);

  if (type === 'command' && packet.command.type === 'take_ownership') {
    const target = attachments.get(runtimeId);
    if (!target) throw new Error('This conversation has been deleted or closed');
    return handle({ ...target, takeOwnership: true });
  }
  if (readonlyViews.has(runtimeId)) {
    return handleReadonly(packet);
  }
  const session = subscriptions.get(runtimeId);
  if (!session) { if (type === 'detach') return { stopped: false }; throw new Error('Pi is not running'); }
  if (type === 'detach') { attachments.delete(runtimeId); return session.detach(runtimeId, packet.discardBlank, packet.preserveRunning); }
  if (type === 'presence') { session.views.set(runtimeId, packet.presence); session.routeDialogs(); session.publishPresence(); return; }
  const command = packet.command;
  return executeSessionCommand(session, runtimeId, command);
}

async function queueSessionCommand(session, command) {
  if (command.type === 'change_pending') return session.queue.changePendingMessage(command.id, command.action);
  if (command.type === 'prompt' && !String(command.message).startsWith('/') && !session.queue.heldMessages) return session.queue.command({ ...command, type: command.streamingBehavior === 'steer' ? 'steer' : 'follow_up' });
  return session.queue.command(command);
}
