import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { ExtensionDialog } from '../../clients/ui/components/ExtensionDialog';
import type { ExtensionUiRequest, ExtensionUiResponse } from '../../clients/ui/types';
import '../../clients/ui/styles.css';

declare global {
  interface Window { respondToExampleInput(response: ExtensionUiResponse): Promise<{ error?: string }> }
}

function Example() {
  const [request, setRequest] = createSignal<ExtensionUiRequest>();
  const [result, setResult] = createSignal('No response');
  return <>
    <button onClick={() => setRequest({ id: 'confirmation', method: 'confirm', title: 'Continue?', message: 'Confirm this action' })}>Open confirmation</button>
    <button onClick={() => setRequest({ id: 'editor', method: 'editor', title: 'Instructions', prefill: 'draft' })}>Open editor</button>
    <button onClick={() => setRequest({ id: 'input', method: 'input', title: 'Name', prefill: 'initial' })}>Open input</button>
    <output aria-label="Dialog response">{result()}</output>
    <Show when={request()}>{value => <ExtensionDialog request={value()} onRespond={async response => {
      if (value().method === 'input') {
        const result = await window.respondToExampleInput(response);
        if (result.error) throw new Error(result.error);
      }
      setResult(JSON.stringify(response)); setRequest(undefined);
    }} />}</Show>
  </>;
}
render(() => <Example />, document.getElementById('root'));
