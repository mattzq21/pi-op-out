import { render } from 'solid-js/web';
import { ContextTokenDiagram } from '../../clients/ui/components/ContextTokenDiagram';
import '../../clients/ui/styles.css';

render(() => <main style={{ height: '200vh', padding: '40px' }}>
  <ContextTokenDiagram tokens={123456} style={{}} />
  <button>Elsewhere</button>
</main>, document.getElementById('root')!);
