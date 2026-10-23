import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import '../../clients/ui/styles.css';
import type { ComposerUpload } from '../../clients/ui/types';

globalThis.isTauri = true;
mockWindows('main');
mockIPC((command, args) => window.nativeCommand(command, args), { shouldMockEvents: true });
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
window.deliverFileDrag = (name, payload) => emit(`tauri://drag-${name}`, payload);
const { Composer } = await import('../../clients/ui/components/Composer');
const [sent, setSent] = createSignal<unknown[]>([]);
const [disabled, setDisabled] = createSignal(false);
const [mounted, setMounted] = createSignal(true);
const [vision, setVision] = createSignal(false);
const [failSends, setFailSends] = createSignal(false);
const [holdSends, setHoldSends] = createSignal(false);
const [controlled, setControlled] = createSignal(false);
const [uploads, setUploads] = createSignal<ComposerUpload[]>([]);
const heldSends: (() => void)[] = [];

render(() => <>
  <label><input type="checkbox" checked={disabled()} onChange={event => setDisabled(event.currentTarget.checked)} />Disable controls</label>
  <label><input type="checkbox" checked={vision()} onChange={event => setVision(event.currentTarget.checked)} />Image-capable model</label>
  <label><input type="checkbox" checked={failSends()} onChange={event => setFailSends(event.currentTarget.checked)} />Fail sends</label>
  <label><input type="checkbox" checked={holdSends()} onChange={event => setHoldSends(event.currentTarget.checked)} />Hold sends</label>
  <label><input type="checkbox" checked={controlled()} onChange={event => setControlled(event.currentTarget.checked)} />Controlled uploads</label>
  <button onClick={() => heldSends.shift()?.()}>Complete send</button>
  <button onClick={() => setMounted(false)}>Remove composer</button>
  <output aria-label="Sent messages">{JSON.stringify(sent())}</output>
  <output aria-label="Uploaded files">{JSON.stringify(uploads().map(upload => upload.name))}</output>
  <div style={{ width: '600px', margin: '80px 150px' }}>
    <Show when={mounted()}>
      <Composer controlsDisabled={disabled()} streaming={false} queued={0} commands={[]} agents={[]} models={[]}
        model={vision() ? { id: 'vision', provider: 'test', input: ['text', 'image'] } : null}
        uploads={controlled() ? uploads() : undefined} onUploadsChange={controlled() ? setUploads : undefined}
        thinkingLevel="off" thinkingLevels={['off']}
        onSend={async (message, behavior, images) => {
          if (holdSends()) await new Promise<void>(resolve => heldSends.push(resolve));
          if (failSends()) throw new Error("offline");
          setSent(values => [...values, [message, behavior, images]]);
        }}
        onPause={async () => {}} onResume={async () => {}} onAbort={async () => {}}
        onAgent={() => {}} onModel={() => {}} onThinking={() => {}} onToggleFastMode={async () => {}} />
    </Show>
  </div>
</>, document.getElementById('root')!);
