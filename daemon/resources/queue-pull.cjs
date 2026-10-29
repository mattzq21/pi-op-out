"use strict";

/**
 * The daemon owns the conversation's queue and saves it. Pi keeps no queued message of its own: when it is ready for one, it takes the next one from the daemon.
 *
 * The daemon offers how many steering messages and follow-ups wait (queue_offer). Pi's checks for queued messages count them, so a run goes on while messages wait,
 * and an extension that starts work on its own sees them. Pi takes a message at a steering poll, at a follow-up poll, when a run could continue,
 * and when Pi is idle while messages wait. A taken message goes through prompt like a sent message, so commands, templates and goal objectives work as before.
 * When a run settles, the messages that Pi took but did not use go back to the daemon. The transcript decides which messages Pi used.
 */

const pullState = Symbol("piop.queue-pull");

const userText = message => message?.role === "user" && Array.isArray(message.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : "";

/**
 * The queue pull of a session. ask(name, data) sends a runtime event that the daemon answers. prompt(session, item) passes a taken message to Pi
 * and resolves with Pi's preflight disposition: "queued" or "started" when Pi took it, "handled" when an extension handled it at once.
 */
function queuePull(session, { ask, prompt } = {}) {
  if (session[pullState]) return session[pullState];
  if (!ask || !prompt) throw new Error("The queue pull of this session is not bound");

  /** How many messages of each kind the daemon offers, numbered by the daemon, and the ids of the daemon's messages that Pi took and has not used yet. */
  const offer = { steer: 0, followUp: 0, sequence: 0 };
  const holding = new Set();
  let starting = false;

  const offered = kind => kind ? offer[kind] > 0 : offer.steer + offer.followUp > 0;

  /** Keeps the newest offer. An offer and the answer to a take can cross, so an older one is ignored. */
  const update = next => {
    if (!Number.isInteger(next?.sequence) || next.sequence <= offer.sequence) return false;
    offer.sequence = next.sequence;
    offer.steer = Number.isInteger(next.steer) && next.steer > 0 ? next.steer : 0;
    offer.followUp = Number.isInteger(next.followUp) && next.followUp > 0 ? next.followUp : 0;
    return true;
  };

  /** Takes the next message of a kind and passes it to Pi. Returns true when Pi queued it or started a run with it. */
  const take = async kind => {
    if (!offered(kind)) return false;
    let answer;

    try { answer = await ask("queue_take", { behavior: kind, holding: [...holding] }); }
    catch (error) { offer[kind] = 0; console.error(`Could not take a queued message: ${error instanceof Error ? error.message : String(error)}`); return false; }

    update(answer?.offer);
    const item = answer?.item;

    if (!item) return false;
    holding.add(item.id);

    try {
      const disposition = await prompt(session, item);

      if (disposition !== "handled") return true;
      // An extension handled the message at once, so it is used without a transcript entry.
      holding.delete(item.id);
      await ask("queue_used", { id: item.id });
      return false;
    } catch (error) {
      holding.delete(item.id);
      await ask("queue_failed", { id: item.id, error: error instanceof Error ? error.message : String(error) }).catch(failure => console.error(failure));
      return false;
    }
  };

  /** Starts a run with the next message when Pi is idle while messages wait. Steering messages go first. */
  const start = async () => {
    if (starting || session.isStreaming || session.isCompacting || !offered()) return;
    starting = true;

    try { if (!(await take("steer"))) await take("followUp"); }
    finally { starting = false; }
  };

  /** Returns the daemon's messages that wait in Pi's own queues unused, so the daemon offers them again in their place. */
  const releaseUnused = async () => {
    const agent = session.agent;
    const released = [];

    for (const [queue, texts] of [[agent.steeringQueue, session._steeringMessages], [agent.followUpQueue, session._followUpMessages]]) {
      queue.messages = queue.messages.filter(message => {
        if (typeof message?.piopQueueId !== "string" || !holding.has(message.piopQueueId)) return true;
        released.push(message.piopQueueId);
        const index = texts.indexOf(userText(message));
        if (index >= 0) texts.splice(index, 1);
        return false;
      });
    }

    holding.clear();

    if (!released.length) return;
    session._emitQueueUpdate();
    await ask("queue_release", { ids: released });
  };

  const pull = {
    offered,
    take,
    start,
    /** The daemon's new offer. Pi idle with waiting messages takes the next one. Returns true when more messages wait than before. */
    setOffer(next) {
      const before = offer.steer + offer.followUp;

      if (!update(next)) return false;
      void start().catch(error => console.error(error));
      return offer.steer + offer.followUp > before;
    },
  };

  bindAgent(session, pull);
  const settled = session._emitAgentSettled;
  session._emitAgentSettled = async function (...args) {
    try { await releaseUnused(); } catch (error) { console.error(`Could not return unused queued messages: ${error instanceof Error ? error.message : String(error)}`); }
    const result = await settled.apply(this, args);
    void start().catch(error => console.error(error));
    return result;
  };

  // The goals extension and others ask whether messages wait; the daemon's waiting messages count.
  const count = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), "pendingMessageCount") ?? Object.getOwnPropertyDescriptor(session.constructor.prototype, "pendingMessageCount");
  Object.defineProperty(session, "pendingMessageCount", { configurable: true, get() { return (count?.get?.call(this) ?? 0) + offer.steer + offer.followUp; } });

  session[pullState] = pull;

  return pull;
}

/** Makes the agent take messages from the daemon at its polls, and count the daemon's waiting messages when it decides whether to continue. */
function bindAgent(session, pull) {
  const agent = session.agent;
  const createLoopConfig = agent.createLoopConfig;
  const hasQueuedMessages = agent.hasQueuedMessages;
  const continueRun = agent.continue;

  agent.hasQueuedMessages = function () { return hasQueuedMessages.call(this) || pull.offered(); };

  agent.createLoopConfig = function (...args) {
    const config = createLoopConfig.apply(this, args);
    const steer = config.getSteeringMessages;
    const followUp = config.getFollowUpMessages;
    config.getSteeringMessages = async () => {
      if (!agent.steeringQueue.hasItems()) await pull.take("steer");

      return steer();
    };
    config.getFollowUpMessages = async () => {
      if (!agent.followUpQueue.hasItems()) await pull.take("followUp");

      return followUp();
    };

    return config;
  };

  // A run continues with a queued message after its last reply. When Pi's own queues are empty, it takes the next message from the daemon first.
  agent.continue = async function (...args) {
    const last = this.state?.messages?.at(-1) ?? this._state?.messages?.at(-1);

    if (last?.role === "assistant" && !hasQueuedMessages.call(this)) {
      if (!(await pull.take("steer"))) await pull.take("followUp");

      if (!hasQueuedMessages.call(this)) return;
    }

    return continueRun.apply(this, args);
  };
}

module.exports = { queuePull };
