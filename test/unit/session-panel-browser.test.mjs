import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startupPage } from '../startup-browser-fixture.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';

async function panelPage(t, { extra = 0, cwd = process.cwd(), recent = false, conversationNames = ['Chat 2', 'Chat 10'], sessionSpecs, remotes, readyGroup, activeName, native } = {}) {
  let page, active = false;
  const pending = new Set(), errors = [];
  t.after(async () => {
    active = false;
    await Promise.allSettled([...pending]);
  });
  const service = await daemonClient(t, (event, payload) => {
    if (!active || event !== 'pi://groups-changed') return;
    const request = page.evaluate(({ event, payload }) => window.deliverPanelEvent(event, payload), { event, payload });
    pending.add(request);
    request.then(() => pending.delete(request), error => { pending.delete(request); errors.push(error); });
  }, { remotes });
  const sessions = [];
  const specs = sessionSpecs ?? [...conversationNames, ...Array.from({ length: extra }, (_, index) => `Extra ${index}`)].map(name => ({ name }));
  for (const { temporary, ...spec } of specs) {
    const chat = await service.invoke('create_temporary_chat', { hostId: spec.hostId ?? 'local' });
    sessions.push({ id: chat.sessionId, path: `/sessions/${chat.sessionId}.jsonl`, cwd: recent || temporary ? chat.cwd : cwd, project: 'repo', messageCount: 1, ...(recent ? { lastMessageAt: sessions.length + 1 } : {}), ...spec });
  }
  page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/session-panel-browser.tsx', ready: `[aria-label="Collapse ${readyGroup ?? (sessions.length && !recent ? 'repo' : 'Recents')}"]`, holdStorage: false,
    prepare: async page => {
      await page.addInitScript(() => {
        const pending = new Set();
        function track(target, done) {
          const settled = new Promise(resolve => {
            target.addEventListener(done, resolve, { once: true });
            target.addEventListener('error', resolve, { once: true });
            target.addEventListener('abort', resolve, { once: true });
          });
          pending.add(settled);
          settled.then(() => pending.delete(settled));
          return target;
        }
        const open = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (...args) { return track(open.apply(this, args), 'success'); };
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) { return track(transaction.apply(this, args), 'complete'); };
        window.settlePanelStorage = async () => { while (pending.size) await Promise.all([...pending]); };
      });
      // The panel gets the chats as listed by the daemon, which registers their projects.
      await page.exposeFunction('panelSessions', async () => { await service.listChats(sessions); return sessions; });
      await page.exposeFunction('panelActiveId', () => sessions.find(session => session.name === activeName)?.id);
      const invoke = (command, args) => command === 'open_project_directory' && native ? native.invoke(command, args) : service.invoke(command, args);
      await page.exposeFunction('panelCommand', (command, args) => {
        if (command === 'daemon_invoke') {
          const { clientId, ...payload } = args.args;
          return invoke(args.command, payload);
        }
        return invoke(command, args);
      });
    },
  });
  await page.getByText('Loading groups…', { exact: true }).waitFor({ state: 'hidden' });
  active = true;
  t.after(() => assert.deepEqual(errors, []));
  const reload = async (group = 'repo', expanded = true) => {
    active = false;
    await Promise.all([...pending]);
    await page.reload();
    await page.getByRole('button', { name: `${expanded ? "Collapse" : "Expand"} ${group}`, exact: true }).waitFor();
    active = true;
  };
  return { page, sessions, reload, service };
}
const conversation = (page, name) => page.getByRole('button', { name: `${name}, Project directory, $0.00`, exact: true });
const names = page => page.locator('.session-main strong').allTextContents();
const waitForFocus = locator => locator.evaluate(node => new Promise(resolve => {
  if (node === document.activeElement) resolve();
  else node.addEventListener('focus', resolve, { once: true });
}));

describe('session panel', { concurrency: 6 }, () => {
test('small pointer movement keeps the conversation order and permits selection', async t => {
  const { page, sessions } = await panelPage(t);
  const first = conversation(page, 'Chat 2');
  const box = await first.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 2, y + 2);
  await page.mouse.up();
  assert.deepEqual(await names(page), ['Chat 2', 'Chat 10']);
  assert.deepEqual(JSON.parse(await page.getByLabel('Selected conversations').textContent()), [sessions[0].id]);
});

test('dropping a conversation after another saves the new order', async t => {
  const { page, reload } = await panelPage(t);
  const first = await conversation(page, 'Chat 2').boundingBox();
  const second = await conversation(page, 'Chat 10').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height * .9, { steps: 8 });
  await page.mouse.up();
  await page.locator('.session-main strong').first().filter({ hasText: 'Chat 10' }).waitFor();
  assert.deepEqual(await names(page), ['Chat 10', 'Chat 2']);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  await page.locator('.session-main strong').first().filter({ hasText: 'Chat 10' }).waitFor();
  assert.deepEqual(await names(page), ['Chat 10', 'Chat 2']);
});

test('a completed drag suppresses its release click but allows the next selection', async t => {
  const { page, sessions } = await panelPage(t);
  const first = await conversation(page, 'Chat 2').boundingBox();
  const second = await conversation(page, 'Chat 10').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height * .9, { steps: 8 });
  await page.mouse.up();
  await page.locator('.session-main strong').first().filter({ hasText: 'Chat 10' }).waitFor();
  assert.deepEqual(JSON.parse(await page.getByLabel('Selected conversations').textContent()), []);
  await conversation(page, 'Chat 2').click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Selected conversations').textContent()), [sessions[0].id]);
});

test('a drop outside any target preserves conversation order and group', async t => {
  const { page, reload } = await panelPage(t);
  const first = await conversation(page, 'Chat 2').boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(sidebar.x + sidebar.width + 100, first.y + first.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await names(page), ['Chat 2', 'Chat 10']);
  const contents = await page.getByRole('button', { name: 'Collapse repo', exact: true }).getAttribute('aria-controls');
  assert.deepEqual(await page.locator(`#${contents} .session-main strong`).allTextContents(), ['Chat 2', 'Chat 10']);
});

test('right button movement does not reorder conversations', async t => {
  const { page, reload } = await panelPage(t);
  const first = await conversation(page, 'Chat 2').boundingBox();
  const second = await conversation(page, 'Chat 10').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(second.x + second.width / 2, second.y + second.height * .9, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  assert.deepEqual(await names(page), ['Chat 2', 'Chat 10']);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await names(page), ['Chat 2', 'Chat 10']);
});

test('search results cannot be reordered by dragging', async t => {
  const { page, reload } = await panelPage(t);
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('Chat');
  assert.deepEqual(await names(page), ['Chat 2', 'Chat 10']);
  const first = await conversation(page, 'Chat 2').boundingBox();
  const second = await conversation(page, 'Chat 10').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height * .9, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.equal(await page.getByRole('textbox', { name: 'Search conversations', exact: true }).inputValue(), '');
  assert.deepEqual(await names(page), ['Chat 2', 'Chat 10']);
});

test('losing window focus stops drag scrolling and keeps conversation assignments', async t => {
  const { page, reload } = await panelPage(t, { extra: 20 });
  const originalOrder = await names(page);
  const scroll = page.locator('.session-scroll');
  assert.equal(await scroll.evaluate(node => node.scrollHeight > node.clientHeight), true);
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await page.bringToFront();
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    const first = await conversation(page, 'Chat 2').boundingBox();
    const area = await scroll.boundingBox();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width / 2, area.y + area.height - 5, { steps: 8 });
    await scroll.evaluate(node => new Promise(resolve => {
      if (node.scrollTop > 0) return resolve();
      node.addEventListener('scroll', resolve, { once: true });
    }));
    assert.ok(await scroll.evaluate(node => node.scrollTop) > 0);
    const other = await page.context().newPage();
    try {
      await other.bringToFront();
      assert.equal(await page.evaluate(() => document.hasFocus()), false);
      const stoppedAt = await scroll.evaluate(node => node.scrollTop);
      await page.bringToFront();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await scroll.evaluate(node => node.scrollTop), stoppedAt);
      await page.mouse.up();
    } finally { await other.close(); }
  } finally { await input.detach(); }
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await names(page), originalOrder);
  const contents = await page.getByRole('button', { name: 'Collapse repo', exact: true }).getAttribute('aria-controls');
  assert.deepEqual(await page.locator(`#${contents} .session-main strong`).allTextContents(), originalOrder);
});

async function createGroup(page, service, name) {
  await service.invoke('change_session_groups', { change: { type: 'create', name } });
  await page.getByRole('button', { name: `Collapse ${name}`, exact: true }).waitFor();
}
async function groupContents(page, name) {
  const disclosure = page.getByRole('button', { name: new RegExp(`^(Collapse|Expand) ${name}$`) });
  const id = await disclosure.getAttribute('aria-controls');
  return page.locator(`#${id}`);
}

test('dropping into a collapsed group moves the conversation and opens that group', async t => {
  const { page, service, reload } = await panelPage(t);
  await createGroup(page, service, 'Research');
  await page.getByRole('button', { name: 'Collapse Research', exact: true }).click();
  const target = await page.getByRole('button', { name: 'Expand Research', exact: true }).boundingBox();
  const source = await conversation(page, 'Chat 2').boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Collapse Research', exact: true }).waitFor();
  await (await groupContents(page, 'Research')).getByRole('button', { name: 'Chat 2, Project directory, $0.00', exact: true }).waitFor();
  assert.deepEqual(await (await groupContents(page, 'repo')).locator('.session-main strong').allTextContents(), ['Chat 10']);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.equal(await conversation(page, 'Chat 2').isVisible(), true);
  assert.deepEqual(await (await groupContents(page, 'Research')).locator('.session-main strong').allTextContents(), ['Chat 2']);
  assert.deepEqual(await (await groupContents(page, 'repo')).locator('.session-main strong').allTextContents(), ['Chat 10']);
});

test('dropping a project on a group nests the project and retains its conversations', async t => {
  const { page, service, reload } = await panelPage(t);
  await createGroup(page, service, 'Research');
  const research = await groupContents(page, 'Research');
  assert.equal(await research.getByRole('button', { name: 'Collapse repo', exact: true }).count(), 0);
  const source = await page.getByRole('button', { name: 'repo', exact: true }).boundingBox();
  const target = await page.getByRole('button', { name: 'Collapse Research', exact: true }).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await research.getByRole('button', { name: 'Collapse repo', exact: true }).waitFor();
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.equal(await (await groupContents(page, 'Research')).getByRole('button', { name: 'Collapse repo', exact: true }).isVisible(), true);
  assert.deepEqual(await (await groupContents(page, 'repo')).locator('.session-main strong').allTextContents(), ['Chat 2', 'Chat 10']);
});

test('dragging a project after a group saves the sidebar order', async t => {
  const { page, service, reload } = await panelPage(t);
  await createGroup(page, service, 'Research');
  await page.getByRole('button', { name: 'Research', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.locator('.project-label').first().filter({ hasText: 'repo' }).waitFor();
  assert.deepEqual(await page.locator('.project-label').allTextContents(), ['repo', 'Research', 'Recents']);
  const source = await page.getByRole('button', { name: 'repo', exact: true }).boundingBox();
  const gap = page.getByRole('button', { name: 'Recents', exact: true }).locator('xpath=ancestor::section[1]/preceding-sibling::*[1]');
  const target = await gap.boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator('.project-label').first().filter({ hasText: 'Research' }).waitFor();
  assert.deepEqual(await page.locator('.project-label').allTextContents(), ['Research', 'repo', 'Recents']);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await page.locator('.project-label').allTextContents(), ['Research', 'repo', 'Recents']);
});

test('conversation menus support Home End and arrow key navigation', async t => {
  const { page } = await panelPage(t);
  await conversation(page, 'Chat 2').click({ button: 'right' });
  const open = page.getByRole('menuitem', { name: 'Open in new window', exact: true });
  await open.waitFor();
  await waitForFocus(open);
  assert.equal(await open.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('menuitem', { name: 'Open project directory', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Home');
  assert.equal(await open.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('menuitem', { name: 'Rename conversation', exact: true }).evaluate(node => node === document.activeElement), true);
});

test('renaming from a conversation menu returns the conversation and restores focus', async t => {
  const { page, sessions } = await panelPage(t);
  const row = conversation(page, 'Chat 2');
  await row.focus();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename conversation', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Conversation actions').textContent()), [[sessions[0], 'rename']]);
  assert.equal(await page.getByRole('menu').count(), 0);
  await waitForFocus(row);
  assert.equal(await row.evaluate(node => node === document.activeElement), true);
});

test('Escape closes a conversation menu and returns focus to its conversation', async t => {
  const { page } = await panelPage(t);
  const row = conversation(page, 'Chat 10');
  await row.focus();
  await row.click({ button: 'right' });
  const open = page.getByRole('menuitem', { name: 'Open in new window', exact: true });
  await open.waitFor();
  await waitForFocus(open);
  assert.equal(await open.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  await waitForFocus(row);
  assert.equal(await row.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(JSON.parse(await page.getByLabel('Conversation actions').textContent()), []);
});

test('a conversation menu closes without an action when its conversation leaves the list', { timeout: 30_000 }, async t => {
  const { page, sessions } = await panelPage(t);
  const [, remaining] = sessions;
  await conversation(page, 'Chat 2').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Chat 2 actions', exact: true }).waitFor();
  sessions.splice(0, 1);
  await page.evaluate(() => window.refreshPanelSessions());
  await conversation(page, 'Chat 2').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Conversation actions').textContent()), []);
  await conversation(page, 'Chat 10').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename conversation', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Conversation actions').textContent()), [[remaining, 'rename']]);
});

test('Ctrl G focuses conversation search', async t => {
  const { page } = await panelPage(t);
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await search.fill('Chat');
  await conversation(page, 'Chat 2').focus();
  await page.keyboard.press('Control+g');
  await waitForFocus(search);
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  await page.keyboard.type('10');
  assert.equal(await search.inputValue(), '10');
  assert.deepEqual(await names(page), ['Chat 10']);
});

test('keyboard reordering of project conversations survives reopening', async t => {
  const { page, reload } = await panelPage(t);
  await conversation(page, 'Chat 2').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.locator('.session-main strong').first().filter({ hasText: 'Chat 10' }).waitFor();
  assert.deepEqual(await names(page), ['Chat 10', 'Chat 2']);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await names(page), ['Chat 10', 'Chat 2']);
});

test('keyboard group reordering survives reopening', async t => {
  const { page, service, reload } = await panelPage(t);
  await createGroup(page, service, 'Research');
  assert.deepEqual(await page.locator('.project-label').allTextContents(), ['Research', 'repo', 'Recents']);
  await page.getByRole('button', { name: 'Research', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.locator('.project-label').first().filter({ hasText: 'repo' }).waitFor();
  assert.deepEqual(await page.locator('.project-label').allTextContents(), ['repo', 'Research', 'Recents']);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await page.locator('.project-label').allTextContents(), ['repo', 'Research', 'Recents']);
});

test('the keyboard can move a conversation into the previous group', async t => {
  const { page, service, reload } = await panelPage(t);
  await createGroup(page, service, 'Research');
  assert.deepEqual(await page.locator('.project-label').allTextContents(), ['Research', 'repo', 'Recents']);
  await conversation(page, 'Chat 2').focus();
  await page.keyboard.press('Alt+Shift+ArrowUp');
  await (await groupContents(page, 'Research')).getByRole('button', { name: 'Chat 2, Project directory, $0.00', exact: true }).waitFor();
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await (await groupContents(page, 'Research')).locator('.session-main strong').allTextContents(), ['Chat 2']);
  assert.deepEqual(await (await groupContents(page, 'repo')).locator('.session-main strong').allTextContents(), ['Chat 10']);
});

test('a new group request opens its name field and notifies the caller', async t => {
  const { page } = await panelPage(t);
  await page.getByRole('button', { name: 'Request new group', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Group name', exact: true });
  await name.waitFor();
  await waitForFocus(name);
  assert.equal(await name.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByLabel('Handled group requests').textContent(), '1');
});

test('new group names are trimmed and survive reopening', async t => {
  const { page, reload } = await panelPage(t);
  await page.getByRole('button', { name: 'Request new group', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Group name', exact: true });
  await input.fill('  Research  ');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'New chat in Research', exact: true }).waitFor();
  assert.equal(await input.count(), 0);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.equal(await page.getByRole('button', { name: 'Group actions for Research', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'New chat in Research', exact: true }).count(), 1);
});

test('renamed groups retain the new name after reopening', async t => {
  const { page, service, reload } = await panelPage(t);
  await createGroup(page, service, 'Research');
  await page.getByRole('button', { name: 'Group actions for Research', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Rename session group', exact: true });
  await input.fill('Notes');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Group actions for Notes', exact: true }).waitFor();
  assert.equal(await input.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Group actions for Research', exact: true }).count(), 0);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.equal(await page.getByRole('button', { name: 'Group actions for Notes', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Group actions for Research', exact: true }).count(), 0);
});

async function rejectGroupName(page, name, message) {
  await page.getByRole('button', { name: 'Request new group', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Group name', exact: true });
  await input.fill(name);
  await page.keyboard.press('Enter');
  const errorId = await input.getAttribute('aria-describedby');
  assert.ok(errorId);
  const error = page.locator(`[id="${errorId}"]`);
  await error.waitFor();
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  assert.match(await error.textContent(), message);
  assert.equal(await input.inputValue(), name);
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
}

test('group creation rejects empty', async t => {
  const { page } = await panelPage(t);
  await rejectGroupName(page, '', /Enter a group name/);
});

test('group creation rejects reserved Recents', async t => {
  const { page } = await panelPage(t);
  await rejectGroupName(page, 'Recents', /already uses/);
});

test('group creation rejects reserved Dirless with spaces', async t => {
  const { page } = await panelPage(t);
  await rejectGroupName(page, ' DIRLESS ', /already uses/);
});

test('group creation rejects existing project name ignoring case', async t => {
  const { page } = await panelPage(t);
  await rejectGroupName(page, 'REPO', /already uses/);
});

test('cancelling group removal keeps the group and its conversations after reopening', async t => {
  const { page, reload } = await panelPage(t);
  await page.getByRole('button', { name: 'Group actions for repo', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Forget group', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.match(await dialog.textContent(), /No chats or directories will be deleted/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await dialog.count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Conversation actions').textContent()), []);
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await (await groupContents(page, 'repo')).locator('.session-main strong').allTextContents(), ['Chat 2', 'Chat 10']);
});

test('confirmed group removal keeps the directory and does not request chat deletion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-panel-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'keep.txt');
  await writeFile(marker, 'project data');
  const { page, reload } = await panelPage(t, { cwd: directory });
  await page.getByRole('button', { name: 'Group actions for repo', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Forget group', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Forget group', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Group actions for repo', exact: true }).count(), 0);
  assert.deepEqual(JSON.parse(await page.getByLabel('Conversation actions').textContent()), []);
  await page.evaluate(() => window.settlePanelStorage());
  await reload('Recents');
  await (await groupContents(page, 'Recents')).locator('.session-main strong').first().waitFor();
  assert.deepEqual(await (await groupContents(page, 'Recents')).locator('.session-main strong').allTextContents(), ['Chat 2', 'Chat 10']);
  assert.equal(await readFile(marker, 'utf8'), 'project data');
});

test('failed group removal keeps the group and can be retried after reconnection', async t => {
  const { page, service, reload } = await panelPage(t);
  await page.getByRole('button', { name: 'Group actions for repo', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Forget group', exact: true }).click();
  await service.disconnect();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Forget group', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.match(await dialog.getByRole('alert').textContent(), /connection is not open/i);
  assert.equal(await page.getByRole('button', { name: 'Group actions for repo', exact: true }).count(), 1);
  assert.deepEqual(await (await groupContents(page, 'repo')).locator('.session-main strong').allTextContents(), ['Chat 2', 'Chat 10']);
  await service.reconnect();
  await dialog.getByRole('button', { name: 'Forget group', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Group actions for repo', exact: true }).count(), 0);
  await page.evaluate(() => window.settlePanelStorage());
  await reload('Recents');
  await (await groupContents(page, 'Recents')).locator('.session-main strong').first().waitFor();
  assert.deepEqual(await (await groupContents(page, 'Recents')).locator('.session-main strong').allTextContents(), ['Chat 2', 'Chat 10']);
});

test('failed group editing can be retried without losing the entered name', async t => {
  const { page, service, reload } = await panelPage(t, { conversationNames: [] });
  await service.disconnect();
  await page.getByRole('button', { name: 'Request new group', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Group name', exact: true });
  await input.fill('Recovered group');
  await page.keyboard.press('Enter');
  await page.locator('input[aria-label="Group name"][aria-invalid="true"]').waitFor();
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  const descriptionId = await input.getAttribute('aria-describedby');
  assert.ok(descriptionId);
  const error = page.locator(`[id="${descriptionId}"]`);
  assert.match(await error.textContent(), /connection is not open/i);
  assert.equal(await input.inputValue(), 'Recovered group');
  await service.reconnect();
  await input.press('Enter');
  await page.getByRole('button', { name: 'Group actions for Recovered group', exact: true }).waitFor();
  assert.equal(await input.count(), 0);
  assert.equal(await error.count(), 0);
  assert.equal(await page.getByText(/connection is not open/i).count(), 0);
  await page.evaluate(() => window.settlePanelStorage());
  await reload('Recovered group');
  assert.equal(await page.getByRole('button', { name: 'Group actions for Recovered group', exact: true }).count(), 1);
});

test('collapsed conversation groups stay collapsed when reopened', async t => {
  const { page, reload } = await panelPage(t);
  await page.getByRole('button', { name: 'Collapse repo', exact: true }).click();
  const expand = page.getByRole('button', { name: 'Expand repo', exact: true });
  assert.equal(await expand.getAttribute('aria-expanded'), 'false');
  assert.equal(await conversation(page, 'Chat 2').isVisible(), false);
  await page.evaluate(() => window.settlePanelStorage());
  await reload('repo', false);
  assert.equal(await expand.getAttribute('aria-expanded'), 'false');
  assert.equal(await conversation(page, 'Chat 2').isVisible(), false);
  await expand.click();
  await conversation(page, 'Chat 2').waitFor();
  assert.equal(await conversation(page, 'Chat 2').isVisible(), true);
  assert.equal(await conversation(page, 'Chat 10').isVisible(), true);
});

test('search reveals matching conversations inside collapsed groups', async t => {
  const { page, reload } = await panelPage(t);
  await page.getByRole('button', { name: 'Collapse repo', exact: true }).click();
  await page.getByRole('button', { name: 'Expand repo', exact: true }).waitFor();
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await search.fill('Chat 2');
  await conversation(page, 'Chat 2').waitFor();
  assert.equal(await conversation(page, 'Chat 10').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'repo', exact: true }).isDisabled(), true);
  await search.fill('');
  assert.equal(await conversation(page, 'Chat 2').isVisible(), false);
  assert.equal(await conversation(page, 'Chat 10').isVisible(), false);
  await page.evaluate(() => window.settlePanelStorage());
  await reload('repo', false);
  assert.equal(await conversation(page, 'Chat 2').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Expand repo', exact: true }).getAttribute('aria-expanded'), 'false');
});

test('recent conversations preserve a user chosen order when reopened', async t => {
  const { page, reload } = await panelPage(t, { recent: true, conversationNames: ['Older', 'Newer'] });
  const recents = await groupContents(page, 'Recents');
  await conversation(page, 'Older').waitFor();
  assert.deepEqual(await recents.locator('.session-main strong').allTextContents(), ['Newer', 'Older']);
  await conversation(page, 'Older').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await recents.locator('.session-main strong').first().filter({ hasText: 'Older' }).waitFor();
  assert.deepEqual(await names(page), ['Older', 'Newer']);
  await page.evaluate(() => window.settlePanelStorage());
  await reload('Recents');
  await conversation(page, 'Older').waitFor();
  assert.deepEqual(await names(page), ['Older', 'Newer']);
});

test('new recent conversations appear before the saved user order', async t => {
  const { page, sessions, service, reload } = await panelPage(t, { recent: true, conversationNames: ['Older', 'Newer'] });
  await conversation(page, 'Older').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.locator('.session-main strong').first().filter({ hasText: 'Older' }).waitFor();
  assert.deepEqual(await names(page), ['Older', 'Newer']);
  const chat = await service.invoke('create_temporary_chat', { hostId: 'local' });
  sessions.push({ id: chat.sessionId, name: 'Newest', path: `/sessions/${chat.sessionId}.jsonl`, cwd: chat.cwd, project: 'repo', messageCount: 1, lastMessageAt: 3 });
  await page.getByRole('button', { name: 'Refresh conversation list', exact: true }).click();
  await page.locator('.session-main strong').first().filter({ hasText: 'Newest' }).waitFor();
  assert.deepEqual(await names(page), ['Newest', 'Older', 'Newer']);
  await page.evaluate(() => window.settlePanelStorage());
  sessions[0].lastMessageAt = 99;
  sessions[2].lastMessageAt = 0;
  await reload('Recents');
  await conversation(page, 'Newest').waitFor();
  assert.deepEqual(await names(page), ['Newest', 'Older', 'Newer']);
});

async function forgetBrowserGroup(page, name) {
  await page.getByRole('button', { name: `Group actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Forget group', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Forget group', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: `Group actions for ${name}`, exact: true }).count(), 0);
}

test('forgetting a group discards its manual conversation order', async t => {
  const { page, reload } = await panelPage(t);
  await conversation(page, 'Chat 2').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.locator('.session-main strong').first().filter({ hasText: 'Chat 10' }).waitFor();
  assert.deepEqual(await names(page), ['Chat 10', 'Chat 2']);
  await forgetBrowserGroup(page, 'repo');
  await page.evaluate(() => window.settlePanelStorage());
  await reload('Recents');
  await conversation(page, 'Chat 2').waitFor();
  assert.deepEqual(await names(page), ['Chat 2', 'Chat 10']);
});

test('a recreated project does not restore a forgotten group conversation order', async t => {
  const { page, sessions, service, reload } = await panelPage(t);
  await conversation(page, 'Chat 2').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.locator('.session-main strong').first().filter({ hasText: 'Chat 10' }).waitFor();
  assert.deepEqual(await names(page), ['Chat 10', 'Chat 2']);
  await forgetBrowserGroup(page, 'repo');
  const chat = await service.invoke('create_temporary_chat', { hostId: 'local' });
  sessions.push({ id: chat.sessionId, name: 'Chat 3', path: `/sessions/${chat.sessionId}.jsonl`, cwd: process.cwd(), project: 'repo', messageCount: 1 });
  // A forgotten project stays forgotten when its chats are listed, so the user makes the group from its folder again.
  await service.invoke('change_session_groups', { change: { type: 'project', project: { id: 'local:' + process.cwd(), name: 'repo', cwd: process.cwd(), hostId: 'local', hostName: 'Local' }, key: 'local:' + chat.sessionId } });
  await page.getByRole('button', { name: 'Refresh conversation list', exact: true }).click();
  await page.getByRole('button', { name: 'Group actions for repo', exact: true }).waitFor();
  const state = await service.invoke('load_session_groups', { seeds: [] });
  const group = state.groups.find(item => item.name === 'repo');
  assert.ok(group);
  for (const session of sessions.slice(0, 2)) await service.invoke('change_session_groups', { change: { type: 'assign', key: 'local:' + session.id, group: group.id } });
  await (await groupContents(page, 'repo')).getByRole('button', { name: 'Chat 2, Project directory, $0.00', exact: true }).waitFor();
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.deepEqual(await (await groupContents(page, 'repo')).locator('.session-main strong').allTextContents(), ['Chat 2', 'Chat 3', 'Chat 10']);
});

test('a recreated project does not restore a forgotten collapse setting', async t => {
  const { page, sessions, service, reload } = await panelPage(t, { conversationNames: ['Chat 2'] });
  await page.getByRole('button', { name: 'Collapse repo', exact: true }).click();
  await page.getByRole('button', { name: 'Expand repo', exact: true }).waitFor();
  assert.equal(await conversation(page, 'Chat 2').isVisible(), false);
  await forgetBrowserGroup(page, 'repo');
  const chat = await service.invoke('create_temporary_chat', { hostId: 'local' });
  sessions.push({ id: chat.sessionId, name: 'Chat 3', path: `/sessions/${chat.sessionId}.jsonl`, cwd: process.cwd(), project: 'repo', messageCount: 1 });
  // A forgotten project stays forgotten when its chats are listed, so the user makes the group from its folder again.
  await service.invoke('change_session_groups', { change: { type: 'project', project: { id: 'local:' + process.cwd(), name: 'repo', cwd: process.cwd(), hostId: 'local', hostName: 'Local' }, key: 'local:' + chat.sessionId } });
  await page.getByRole('button', { name: 'Refresh conversation list', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse repo', exact: true }).waitFor();
  await conversation(page, 'Chat 3').waitFor();
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.equal(await page.getByRole('button', { name: 'Collapse repo', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.equal(await conversation(page, 'Chat 3').isVisible(), true);
});

test('project grouping and focus stay stable when the incoming session list changes order', async t => {
  const { page, sessions } = await panelPage(t, {
    sessionSpecs: [
      { name: 'Remote conversation', hostId: 'remote', hostName: 'Remote', project: 'folder', cwd: process.cwd() + '/test' },
      { name: 'Local conversation', project: 'Local' },
      { name: 'Temporary conversation', temporary: true },
    ],
    remotes: [{ id: 'remote', name: 'Remote', target: 'remote' }], readyGroup: 'Local',
  });
  const groups = page.locator('.project-label');
  await conversation(page, 'Remote conversation').waitFor();
  assert.deepEqual(await groups.allTextContents(), ['Remote / folder', 'Local', 'Recents']);
  const remote = conversation(page, 'Remote conversation');
  await remote.focus();
  sessions.reverse();
  await page.evaluate(() => window.refreshPanelSessions());
  assert.deepEqual(await groups.allTextContents(), ['Remote / folder', 'Local', 'Recents']);
  assert.deepEqual(await (await groupContents(page, 'Local')).locator('.session-main strong').allTextContents(), ['Local conversation']);
  assert.deepEqual(await (await groupContents(page, 'Remote / folder')).locator('.session-main strong').allTextContents(), ['Remote conversation']);
  assert.deepEqual(await (await groupContents(page, 'Recents')).locator('.session-main strong').allTextContents(), ['Temporary conversation']);
  assert.equal(await remote.evaluate(node => node === document.activeElement), true);
});

test('the active conversation offers window and project actions without splitting', async t => {
  const { page } = await panelPage(t, { activeName: 'Chat 2' });
  const row = conversation(page, 'Chat 2');
  assert.equal(await row.getAttribute('aria-current'), 'page');
  await row.click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Split pane', exact: true }).count(), 0);
  assert.equal(await page.getByRole('menuitem', { name: 'Open in new window', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('menuitem', { name: 'Open project directory', exact: true }).isVisible(), true);
});

test('opening a deleted project directory shows the native error and leaves group actions available', async t => {
  const native = await nativeFileCommand(t);
  const directory = join(native.directory, 'project');
  await mkdir(directory);
  const { page } = await panelPage(t, { cwd: directory, native });
  await rm(directory, { recursive: true });
  await page.getByRole('button', { name: 'Group actions for repo', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open directory', exact: true }).click();
  const alert = page.getByRole('alert');
  await alert.waitFor();
  assert.match(await alert.textContent(), /Project directory does not exist/);
  assert.ok((await alert.textContent()).includes(directory));
  await page.getByRole('button', { name: 'Group actions for repo', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Forget group', exact: true }).isVisible(), true);
});

test('a new group can be made from a project folder, is named after the folder, and survives reopening', async t => {
  const projects = await mkdtemp(join(tmpdir(), 'piop-group-project-'));
  t.after(() => rm(projects, { recursive: true, force: true }));
  const folder = join(projects, 'billing-service');
  await mkdir(folder);
  const { page, reload, service } = await panelPage(t);
  await page.getByRole('button', { name: 'Request new group', exact: true }).click();
  await page.getByRole('button', { name: 'Choose project', exact: true }).click();
  const path = page.getByRole('combobox', { name: /^(Search or type a folder path|Folder path relative to home)$/ });
  await path.fill(folder + '/');
  await page.getByRole('button', { name: /^Open current folder/ }).click();
  await page.getByRole('button', { name: 'Group actions for billing-service', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Group name', exact: true }).count(), 0);
  const saved = (await service.invoke('load_session_groups', { seeds: [] })).groups.find(group => group.name === 'billing-service');
  assert.deepEqual([saved.cwd, saved.hostId ?? 'local'], [folder, 'local'], 'the group belongs to the chosen folder');
  await page.evaluate(() => window.settlePanelStorage());
  await reload();
  assert.equal(await page.getByRole('button', { name: 'Group actions for billing-service', exact: true }).count(), 1);
});

});
