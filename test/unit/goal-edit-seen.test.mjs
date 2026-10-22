import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) { return next(specifier === '@earendil-works/pi-ai' ? 'typebox' : specifier, context); } });
const { registerGoals } = await import('../../daemon/resources/piop-goals/goals.ts');
const { registerGoalTools } = await import('../../daemon/resources/piop-goals/tools.ts');

/** A goal extension in a working agent, with an active goal "Objective A". */
function goalAgent() {
  const handlers = new Map();
  const tools = new Map();
  const notices = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    events: { on() { return () => {}; }, emit(name, request) { if (name === 'hooks-extended') request.hooks = { on() {} }; if (name === 'piop:storage:session') request.storage = { writeGoal() {} }; } },
    getActiveTools: () => ['update_goal_status'],
    sendMessage(message) { notices.push(message); },
    sendUserMessage() {},
    registerTool(tool) { tools.set(tool.name, tool); },
  };
  const ctx = { isIdle: () => false, hasPendingMessages: () => false, sessionManager: { getSessionId: () => 'chat', getSessionFile: () => '/unused/chat.jsonl' }, ui: { setWidget() {}, setStatus() {}, notify() {} } };
  const { core, session } = registerGoals(pi);
  registerGoalTools(pi, core);
  core.state.goal = { id: 'goal-1', sessionId: 'chat', objective: 'Objective A', status: 'active' };
  const request = (messages = []) => handlers.get('context')({ messages }, ctx);
  const complete = () => tools.get('update_goal_status').execute('call', { status: 'complete' }, undefined, undefined, ctx);
  const edit = objective => { core.state.goal.objective = objective; core.changed(ctx); };
  return { core, session, ctx, request, complete, edit, notices };
}

test('completing a goal edited after the last request fails once with the edit message, then succeeds', async () => {
  const agent = goalAgent();
  await agent.request();
  await agent.session.pause(agent.ctx);
  agent.edit('Objective B');
  await agent.session.resume(agent.ctx);
  await agent.request();
  await assert.rejects(agent.complete(), /The goal was edited by the user\. Current goal is:\nObjective B/);
  await agent.complete();
  assert.equal(agent.core.state.goal, null);
});

test('the edit notice in a request gives the model the new objective, so completion succeeds', async () => {
  const agent = goalAgent();
  await agent.request();
  // After a resume during a task, the continuation prompt waits for the task end, so the notice is the only source of the new objective.
  await agent.session.pause(agent.ctx);
  await agent.session.resume(agent.ctx);
  agent.edit('Objective B');
  await agent.request(agent.notices.map(message => ({ ...message, role: 'custom', timestamp: Date.now() })));
  await agent.complete();
  assert.equal(agent.core.state.goal, null);
});
