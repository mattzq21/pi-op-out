import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ResizableSidebar } from '../../clients/ui/components/ResizableSidebar';

function SidebarExample() {
  const [compact, setCompact] = createSignal(false);
  return <>
    <button onClick={() => setCompact(value => !value)}>Toggle compact sidebar</button>
    <ResizableSidebar compact={compact()}>Sessions</ResizableSidebar>
  </>;
}

render(() => <SidebarExample />, document.getElementById('app')!);
