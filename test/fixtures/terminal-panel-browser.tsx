import { render } from 'solid-js/web';
import { ResizableTerminalPanel } from '../../clients/ui/components/ResizableTerminalPanel';
import '../../clients/ui/styles.css';

render(() => <main style={{ height: '100vh', display: 'flex', 'flex-direction': 'column', 'justify-content': 'flex-end' }}>
  <ResizableTerminalPanel><pre>$ terminal</pre></ResizableTerminalPanel>
</main>, document.getElementById('root')!);
