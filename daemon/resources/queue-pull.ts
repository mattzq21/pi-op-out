import { patchGetter, patchMethod } from './pi-patch.ts';

const pullState = Symbol("piop.queue-pull");

const userText = message => message?.role === "user" && Array.isArray(message.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : "";

type QueuePullBindings = {
  ask: (name: string, payload: unknown) => Promise<any>;
  prompt: (session, item) => Promise<unknown>;
  insert: (session, insertion) => Promise<unknown>;
  tools: (state: unknown) => void;
  steer: (count: number) => void;
};

function queuePull(session, { ask, prompt, insert, tools, steer }: Partial<QueuePullBindings> = {}) {
  if (session[pullState]) return session[pullState];
  if (!ask || !prompt || !insert || !tools || !steer) throw new Error("The queue pull of this session is not bound");

  const offer = { steer: 0, followUp: 0, goal: 0, sequence: 0 };
  const holding = new Set();
  let starting = false;
  let toolState = "";
  let reportedSteer = 0;

  const reportSteer = () => {
    if (offer.steer === reportedSteer) return;
    reportedSteer = offer.steer;
    try { steer(offer.steer); } catch (error) { console.error(`Could not report the queued steer messages: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const offered = (kind?) => kind ? offer[kind] > 0 : offer.steer + offer.followUp > 0;

  const update = next => {
    if (!Number.isInteger(next?.sequence) || next.sequence <= offer.sequence) return false;
    offer.sequence = next.sequence;
    offer.steer = Number.isInteger(next.steer) && next.steer > 0 ? next.steer : 0;
    offer.followUp = Number.isInteger(next.followUp) && next.followUp > 0 ? next.followUp : 0;
    offer.goal = next.goal === 1 ? 1 : 0;
    reportSteer();
    const state = next.tools && typeof next.tools === "object" ? JSON.stringify(next.tools) : toolState;

    if (state !== toolState) {
      toolState = state;
      try { tools(next.tools); } catch (error) { console.error(`Could not update the queue's tools: ${error instanceof Error ? error.message : String(error)}`); }
    }

    return true;
  };

  const report = async outcome => {
    try { update(await ask("queue_outcome", { outcome })); }
    catch (error) { console.error(`Could not report how the run ended: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const take = async kind => {
    if (!offered(kind)) return false;
    let answer;

    try { answer = await ask("queue_take", { behavior: kind, holding: [...holding] }); }
    catch (error) { offer[kind] = 0; reportSteer(); console.error(`Could not take a queued message: ${error instanceof Error ? error.message : String(error)}`); return false; }

    update(answer?.offer);
    const item = answer?.item;

    if (!item) return false;

    if (item.insertion) {
      try { await insert(session, item.insertion); return true; }
      catch (error) { console.error(`Could not add the goal prompt: ${error instanceof Error ? error.message : String(error)}`); return false; }
    }

    holding.add(item.id);

    try {
      for (const message of Array.isArray(item.context) ? item.context : []) await session.sendCustomMessage(message, { triggerTurn: false });
      const disposition = await prompt(session, item);

      if (disposition !== "handled") return true;
      holding.delete(item.id);
      await ask("queue_used", { id: item.id });
      return false;
    } catch (error) {
      holding.delete(item.id);
      await ask("queue_failed", { id: item.id, error: error instanceof Error ? error.message : String(error) }).catch(failure => console.error(failure));
      return false;
    }
  };

  const start = async () => {
    if (starting || session.isStreaming || session.isCompacting || !(offered() || offered("goal"))) return;
    starting = true;

    try { if (!(await take("steer")) && !(await take("followUp"))) await take("goal"); }
    finally { starting = false; }
  };

  const releaseUnused = async () => {
    const agent = session.agent;
    const released: string[] = [];

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
    setOffer(next) {
      if (!update(next)) return;
      void start().catch(error => console.error(error));
    },
  };

  bindAgent(session, pull);
  patchMethod(session, "_emitAgentSettled", settled => async function (this: any, ...args) {
    const aborted = this._agentRunAbortRequested;
    try { await releaseUnused(); } catch (error) { console.error(`Could not return unused queued messages: ${error instanceof Error ? error.message : String(error)}`); }
    if (aborted) await report("aborted");
    const result = await settled.apply(this, args);
    void start().catch(error => console.error(error));
    return result;
  });

  patchMethod(session, "_runBeforeSettleBoundary", beforeSettle => async function (this: any, ...args) {
    const outcome = this._lastActivityOutcome;

    if (outcome !== "completed") await report(outcome);

    if (await beforeSettle.apply(this, args)) return true;

    if (outcome !== "completed" || this._agentRunAbortRequested) return false;

    return take("goal");
  });

  patchGetter(session, "pendingMessageCount", count => function (this: any) { return (count.call(this) as number) + offer.steer + offer.followUp; });

  session[pullState] = pull;

  return pull;
}

function bindAgent(session, pull) {
  const agent = session.agent;
  const hasQueuedMessages = patchMethod(agent, "hasQueuedMessages", original => function (this: any) { return original.call(this) || pull.offered(); });

  patchMethod(agent, "createLoopConfig", createLoopConfig => function (this: any, ...args) {
    const config = createLoopConfig.apply(this, args);
    patchMethod(config, "getSteeringMessages", steer => async () => {
      if (!agent.steeringQueue.hasItems()) await pull.take("steer");

      return steer();
    }, "Agent loop config");
    patchMethod(config, "getFollowUpMessages", followUp => async () => {
      if (!agent.followUpQueue.hasItems()) await pull.take("followUp");

      return followUp();
    }, "Agent loop config");

    return config;
  });

  patchMethod(agent, "continue", continueRun => async function (this: any, ...args) {
    const last = this.state?.messages?.at(-1) ?? this._state?.messages?.at(-1);

    if (last?.role === "assistant" && !hasQueuedMessages.call(this)) {
      if (!(await pull.take("steer"))) await pull.take("followUp");

      if (!hasQueuedMessages.call(this)) return;
    }

    return continueRun.apply(this, args);
  });
}

export { queuePull };
