import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ResizableSidebar } from '../../clients/ui/components/ResizableSidebar';
import '../../clients/ui/styles.css';

const [compact, setCompact] = createSignal(false);
render(() => <main style={{ display: 'flex', height: '100vh' }}>
  <ResizableSidebar compact={compact()}><nav>Chats</nav></ResizableSidebar>
  <label><input type="checkbox" onChange={event => setCompact(event.currentTarget.checked)} />Compact</label>
</main>, document.getElementById('root')!);
