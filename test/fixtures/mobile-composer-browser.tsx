import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { Composer } from '../../clients/ui/components/Composer';
import '../../clients/ui/styles.css';
import '../../clients/ui/mobile.css';

document.documentElement.dataset.mobile = 'true';
const [sent, setSent] = createSignal<unknown[]>([]);
render(() => <main style={{ width: '100%' }}>
  <output aria-label="Sent messages">{JSON.stringify(sent())}</output>
  <Composer streaming queued={0} commands={[]} agents={[]} models={[]} model={null}
    thinkingLevel="off" thinkingLevels={['off']}
    onSend={async (message, behavior, images) => { setSent(values => [...values, { message, behavior, images }]); }}
    onPause={() => {}} onResume={() => {}} onAbort={() => {}}
    onAgent={() => {}} onModel={() => {}} onThinking={() => {}} onToggleFastMode={() => {}} />
</main>, document.getElementById('root')!);
