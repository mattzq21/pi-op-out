import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { RemoveGroupDialog } from '../../clients/ui/components/RemoveGroupDialog';
import '../../clients/ui/styles.css';

declare global {
  interface Window { removeExampleGroup(): Promise<{ error?: string }> }
}

function Example() {
  const [open, setOpen] = createSignal(false);
  const [removed, setRemoved] = createSignal(false);
  return <>
    <output aria-label="Group state">{removed() ? 'Group removed' : 'Work group'}</output>
    <button disabled={removed()} onClick={() => setOpen(true)}>Remove Work</button>
    <Show when={open()}><RemoveGroupDialog name="Work" onCancel={() => setOpen(false)} onRemove={async () => {
      const result = await window.removeExampleGroup();
      if (result.error) throw new Error(result.error);
      setRemoved(true); setOpen(false);
    }} /></Show>
  </>;
}
render(() => <Example />, document.getElementById('root'));
