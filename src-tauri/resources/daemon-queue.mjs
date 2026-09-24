class SessionQueue {
  pendingMessages = [];
  heldMessages;
  queueSnapshot = {
    type: "queue_update",
    steering: [],
    followUp: []
  };
  changingQueue = false;
  clearingQueue = false;
  sendingPending = new Set();
  awaitingSteering = [];
  steeringTimestamps = new Set();
  queueCommands = Promise.resolve();
  inferenceRevision = 0;
  listeners = new Set();
  constructor(raw, publish) {
    this.raw = raw;
    this.listeners.add(publish);
  }
  async executeCommand(command) {
    if (command.type === 'clear_queue') this.clearingQueue = true;
    try {
      return await this.raw(command);
    } finally {
      if (command.type === 'clear_queue') this.clearingQueue = false;
    }
  }
  disconnect() {
    return this.raw({
      type: 'force_stop'
    });
  }
  emit(event) {
    this.listeners.forEach((listener) => listener(event));
  }
  receive(event) {
    if (event.type === 'agent_start') this.inferenceRevision++;
    if (event.type === 'disconnected') {
      this.pendingMessages = this.pendingMessages.map((item) => ({
        ...item,
        retry: true
      }));
      this.heldMessages = undefined;
      this.queueSnapshot = {
        type: 'queue_update',
        steering: [],
        followUp: []
      };
      this.publishQueue();
    }
    if (event.type === "queue_update") { this.receiveQueue(event); return; }
    event = this.tagSteeringMessage(event);
    if (event.type === "agent_settled") this.awaitingSteering = [];
    this.emit(event);
  }
  receiveQueue(event) {
    this.trackConsumedSteering(event);
    for (const behavior of [
      "steer",
      "followUp"
    ]) {
      const before = [
        ...this.queueSnapshot[behavior === "steer" ? "steering" : "followUp"] ?? []
      ];
      const added = (event[behavior === "steer" ? "steering" : "followUp"] ?? []).filter((text) => {
        const index = before.indexOf(text);
        if (index < 0) return true;
        before.splice(index, 1);
        return false;
      });
      const sending = this.pendingMessages.filter((item) => this.sendingPending.has(item.id) && item.behavior === behavior);
      if (added.length === 1 && sending.length === 1) sending[0].message = added[0];
    }
    this.queueSnapshot = event;
    if (!this.changingQueue) this.publishQueue();
  }
  tagSteeringMessage(event) {
    if ((event.type === "message_start" || event.type === "message_end") && event.message) {
      const message = event.message;
      if (message.role === "user" && typeof message.timestamp === "number") {
        if (event.type === "message_start") this.trackSteeringTimestamp(message);
        if (this.steeringTimestamps.has(message.timestamp)) event = {
          ...event,
          message: {
            ...message,
            deliveryBehavior: "steer"
          }
        };
      }
    }
    return event;
  }
  trackSteeringTimestamp(message) {
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
    const index = this.awaitingSteering.indexOf(text);
    const sending = this.pendingMessages.some((item) => this.sendingPending.has(item.id) && item.behavior === "steer" && item.message === text);
    if (index >= 0 || sending) this.steeringTimestamps.add(message.timestamp);
    if (index >= 0) this.awaitingSteering.splice(index, 1);
  }
  trackConsumedSteering(event) {
    if (!this.clearingQueue) {
      const remaining = [
        ...event.steering ?? []
      ];
      for (const text of this.queueSnapshot.steering ?? []) {
        const index = remaining.indexOf(text);
        if (index >= 0) remaining.splice(index, 1);
        else this.awaitingSteering.push(text);
      }
    }
  }
  pruneStaleMessages(available) {
    for (const behavior of [
      "steer",
      "followUp"
    ]) {
      const texts = this.queueSnapshot[behavior === "steer" ? "steering" : "followUp"] ?? [];
      for (const text of new Set(texts)) {
        const matches = available.filter((item) => !item.retry && !this.sendingPending.has(item.id) && item.behavior === behavior && item.message === text);
        const count = texts.filter((item) => item === text).length;
        for (const stale of matches.slice(0, Math.max(0, matches.length - count))) available.splice(available.indexOf(stale), 1);
      }
    }
  }
  queueView(pendingMessages = this.pendingMessages) {
    return {
      ...this.queueSnapshot,
      steering: [
        ...this.queueSnapshot.steering ?? [],
        ...(this.heldMessages ?? []).filter((item) => item.behavior === "steer" && !item.retry).map((item) => item.message)
      ],
      followUp: [
        ...this.queueSnapshot.followUp ?? [],
        ...(this.heldMessages ?? []).filter((item) => item.behavior === "followUp" && !item.retry).map((item) => item.message)
      ],
      pendingMessages
    };
  }
  publishQueue() {
    const heldIds = new Set(this.heldMessages?.map((item) => item.id));
    const available = this.pendingMessages.filter((item) => !heldIds.has(item.id));
    const pending = [];
    this.pruneStaleMessages(available);
    for (const behavior of [
      "steer",
      "followUp"
    ]) {
      for (const message of this.queueSnapshot[behavior === "steer" ? "steering" : "followUp"] ?? []) {
        const index = available.findIndex((item) => !item.retry && item.behavior === behavior && item.message === message);
        if (index >= 0) pending.push(available.splice(index, 1)[0]);
      }
    }
    const visible = [
      ...pending,
      ...this.heldMessages ?? [],
      ...available.filter((item) => item.retry)
    ];
    this.pendingMessages = [
      ...visible,
      ...available.filter((item) => !item.retry && this.sendingPending.has(item.id))
    ];
    const event = this.queueView(visible);
    this.listeners.forEach((listener) => listener(event));
  }
  serializeQueue(action) {
    const next = this.queueCommands.then(action, action);
    this.queueCommands = next.catch(() => undefined);
    return next;
  }
  async holdQueue() {
    if (this.heldMessages) return;
    const originals = [
      ...this.pendingMessages
    ];
    for (const [key, behavior] of [
      [
        "steering",
        "steer"
      ],
      [
        "followUp",
        "followUp"
      ]
    ]) {
      const texts = this.queueSnapshot[key] ?? [];
      for (const text of new Set(texts)) if (originals.filter((item) => !item.retry && item.behavior === behavior && item.message === text).length < texts.filter((value) => value === text).length) throw new Error("Cannot preserve all queued attachments while pausing. Wait for messages sent outside this window to finish first.");
    }
    this.changingQueue = true;
    try {
      const cleared = await this.executeCommand({
        type: "clear_queue"
      });
      this.heldMessages = [
        "steer",
        "followUp"
      ].flatMap((behavior) => {
        const texts = cleared[behavior === "steer" ? "steering" : "followUp"];
        const matches = new Map();
        for (const text of new Set(texts)) {
          const count = texts.filter((value) => value === text).length;
          matches.set(text, originals.filter((item) => !item.retry && item.behavior === behavior && item.message === text).slice(-count));
        }
        return texts.map((message) => matches.get(message)?.shift() ?? {
          id: crypto.randomUUID(),
          message,
          behavior,
          retry: true
        });
      });
    } finally {
      this.changingQueue = false;
      this.publishQueue();
    }
  }
  heldQueueFailed() {
    const held = this.heldMessages ?? [];
    held.forEach((item) => {
      item.retry = true;
    });
    this.heldMessages = undefined;
    this.pendingMessages = [
      ...this.pendingMessages.filter((item) => !held.some((saved) => saved.id === item.id)),
      ...held
    ];
    this.publishQueue();
  }
  async restoreHeldQueue() {
    if (!this.heldMessages) return;
    while (this.heldMessages.length) {
      const item = this.heldMessages.shift();
      if (item.retry) continue;
      try {
        await this.deliverPending(item);
      } catch (reason) {
        this.heldMessages.unshift(item);
        this.heldQueueFailed();
        throw reason;
      }
      this.publishQueue();
    }
    this.heldMessages = undefined;
    this.publishQueue();
  }
  resumesHeldQueue(command) { return command.type === "resume" || command.type === "prompt" && this.heldMessages && typeof command.message === "string"; }
  command(command) {
    if (command.type === "abort") {
      const cancelling = this.executeCommand({ type: "cancel_preparation" });
      void cancelling.catch(() => undefined);
      return this.serializeQueue(async () => { await cancelling; await this.holdQueue(); return this.stop(command); });
    }
    if (command.type === "pause") return this.serializeQueue(async () => {
      await this.holdQueue();
      try {
        return await this.executeCommand(command);
      } catch (reason) {
        this.heldQueueFailed();
        throw reason;
      }
    });
    if (this.resumesHeldQueue(command)) return this.serializeQueue(async () => {
      const revision = this.inferenceRevision;
      const result = await this.executeCommand(command);
      if (command.type === "resume" || !String(command.message).startsWith("/") || this.inferenceRevision !== revision) await this.restoreHeldQueue();
      return result;
    });
    if (command.type !== "steer" && command.type !== "follow_up") {
      if ([
        "clear_queue",
        "new_session",
        "switch_session",
        "fork",
        "clone",
        "fork_and_forget"
      ].includes(command.type)) return this.serializeQueue(() => this.executeCommand(command));
      // Compaction stays pending until it finishes; Stop still needs access to the queue.
      if (command.type === "compact") return this.executeCommand(command);
      return command.type.startsWith('get_') ? this.executeCommand(command) : this.serializeQueue(() => this.executeCommand(command));
    }
    return this.serializeQueue(async () => {
      const pending = {
        id: crypto.randomUUID(),
        message: String(command.message),
        behavior: command.type === "steer" ? "steer" : "followUp",
        images: command.images
      };
      this.pendingMessages.push(pending);
      if (this.heldMessages) {
        this.heldMessages.push(pending);
        this.heldMessages.sort((a, b) => Number(a.behavior === "followUp") - Number(b.behavior === "followUp"));
        this.publishQueue();
        return undefined;
      }
      this.sendingPending.add(pending.id);
      try {
        return await this.deliverPending(pending);
      } catch (reason) {
        this.pendingMessages = this.pendingMessages.filter((item) => item !== pending);
        throw reason;
      } finally {
        this.sendingPending.delete(pending.id);
        this.publishQueue();
      }
    });
  }
  async stop(command) {
    try {
      return await this.executeCommand(command);
    } catch (reason) {
      if (!(reason instanceof Error) || reason.message !== "Pi command timed out") throw reason;
      await this.disconnect();
      this.pendingMessages = this.pendingMessages.map((item) => ({
        ...item,
        retry: true
      }));
      this.heldMessages = undefined;
      this.queueSnapshot = {
        type: "queue_update",
        steering: [],
        followUp: []
      };
      this.awaitingSteering = [];
      this.publishQueue();
      this.emit({
        type: "disconnected"
      });
      return undefined;
    }
  }
  async deliverPending(item) {
    this.sendingPending.add(item.id);
    try {
      return await this.executeCommand({
        type: "prompt",
        message: item.message,
        streamingBehavior: item.behavior,
        ...item.images?.length ? {
          images: item.images
        } : {}
      });
    } finally {
      this.sendingPending.delete(item.id);
    }
  }
  moveItem(items, id, neighborId, action) {
    const from = items.findIndex((item) => item.id === id);
    const to = items.findIndex((item) => item.id === neighborId);
    if (from >= 0 && to >= 0) {
      if (typeof action === "object") {
        const [item] = items.splice(from, 1);
        const destination = items.findIndex((entry) => entry.id === neighborId);
        items.splice(destination + (action.edge === "after" ? 1 : 0), 0, item);
      } else[items[from], items[to]] = [
        items[to],
        items[from]
      ];
    }
  }
  changeHeldMessage(id, target, behavior, neighbor, action) {
    if (behavior === "remove") this.heldMessages = this.heldMessages.filter((item) => item.id !== id);
    else if (behavior === "steer" || behavior === "followUp") {
      target.behavior = behavior;
      target.retry = false;
    } else if (neighbor) {
      this.moveItem(this.heldMessages, id, neighbor.id, action);
    }
    this.heldMessages.sort((a, b) => Number(a.behavior === "followUp") - Number(b.behavior === "followUp"));
    this.publishQueue();
  }
  async retryMessage(id, target, behavior) {
    if (behavior === "remove") {
      this.pendingMessages = this.pendingMessages.filter((item) => item.id !== id);
      this.publishQueue();
      return;
    }
    target.retry = false;
    target.behavior = behavior === "steer" ? "steer" : "followUp";
    try {
      await this.deliverPending(target);
      this.publishQueue();
    } catch (reason) {
      target.retry = true;
      this.publishQueue();
      throw reason;
    }
  }
  assertQueueCanChange() {
    const snapshot = [
      ...this.queueSnapshot.steering ?? [],
      ...this.queueSnapshot.followUp ?? []
    ];
    if (new Set(snapshot).size !== snapshot.length || snapshot.some((message) => !this.pendingMessages.some((item) => !item.retry && item.message === message))) throw new Error("This queue contains messages that cannot be safely switched. Use Ctrl+Enter to steer a new message.");
  }
  async changeLiveMessage(id, behavior, neighbor, action) {
    this.assertQueueCanChange();
    const originals = [
      ...this.pendingMessages
    ];
    this.changingQueue = true;
    try {
      const cleared = await this.executeCommand({
        type: "clear_queue"
      });
      const remaining = [
        "steer",
        "followUp"
      ].flatMap((mode) => (cleared[mode === "steer" ? "steering" : "followUp"] ?? []).map((text) => {
        const original = originals.find((item) => !item.retry && item.behavior === mode && item.message === text);
        return original ? {
          ...original,
          behavior: original.id === id && (behavior === "steer" || behavior === "followUp") ? behavior : mode
        } : {
          id: crypto.randomUUID(),
          message: text,
          behavior: mode,
          retry: true
        };
      }));
      if (neighbor) {
        this.moveItem(remaining, id, neighbor.id, action);
      }
      if (behavior === "remove") {
        const index = remaining.findIndex((item) => item.id === id);
        if (index >= 0) remaining.splice(index, 1);
      }
      this.pendingMessages = [
        ...originals.filter((item) => item.retry),
        ...remaining
      ];
      if (remaining.some((item) => item.retry)) {
        remaining.forEach((item) => {
          item.retry = true;
        });
        throw new Error("Another source changed the queue while switching. Pending text has been kept for retry; reattach any images from messages sent outside this window.");
      }
      for (let index = 0; index < remaining.length; index += 1) {
        try {
          await this.deliverPending(remaining[index]);
        } catch (reason) {
          remaining.slice(index).forEach((item) => {
            item.retry = true;
          });
          throw reason;
        }
      }
    } finally {
      this.changingQueue = false;
      this.publishQueue();
    }
  }
  pendingNeighbor(target, action, behavior, moving) {
    const id = target.id;
    const peers = this.pendingMessages.filter((item) => !item.retry && item.behavior === target.behavior);
    return typeof action === "object" ? peers.find((item) => item.id === action.targetId && item.id !== id) : moving ? peers[peers.findIndex((item) => item.id === id) + (behavior === "moveUp" ? -1 : 1)] : undefined;
  }
  isReordering(behavior) { return ["moveUp", "moveDown", "reorder"].includes(behavior); }
  changePendingMessage(id, action) {
    if (action === "remove" && this.sendingPending.has(id)) {
      const cancelling = this.executeCommand({ type: "cancel_preparation" });
      void cancelling.catch(() => undefined);
      return this.serializeQueue(async () => {
        await cancelling;
        if (this.pendingMessages.some((item) => item.id === id)) await this.changeLiveMessage(id, "remove", undefined, "remove");
      });
    }
    return this.serializeQueue(async () => {
      const target = this.pendingMessages.find((item) => item.id === id);
      if (!target) return;
      const behavior = typeof action === "string" ? action : "reorder";
      const moving = this.isReordering(behavior);
      const neighbor = this.pendingNeighbor(target, action, behavior, moving);
      if (moving && (target.retry || !neighbor)) return;
      if (this.heldMessages?.some((item) => item.id === id)) {
        this.changeHeldMessage(id, target, behavior, neighbor, action);
        return;
      }
      if (target.retry) {
        await this.retryMessage(id, target, behavior);
        return;
      }
      await this.changeLiveMessage(id, behavior, neighbor, action);
    });
  }
}
