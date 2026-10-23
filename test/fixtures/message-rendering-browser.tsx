import { render } from 'solid-js/web';
import { Message } from '../../clients/ui/components/Message';
import '../../clients/ui/styles.css';

const kind = new URLSearchParams(location.search).get("kind");
const html = '<script>window.injected = "script"</script>\n\nPlain <b onclick="window.injected = \'click\'">bold</b> <img src="x" onerror="window.injected = \'image\'">';

render(() => <>
  <button>Outside message</button>
  <main style={{ width: '700px', height: '400px', overflow: 'auto', margin: '80px auto' }}>
  <Message message={kind === "link" ? { id: "link", role: "assistant", content: "[link](https://example.com)" } : kind === "code" ? { id: 'code', role: 'assistant', content: '```js\nconst answer = 42;\n```' } : kind === "html" ? { id: 'html', role: 'assistant', content: html } : { id: 'source', role: 'user', content: '**source**' }} />
  {kind === 'link' && <div aria-hidden="true" style={{ height: '1200px' }} />}
</main></>, document.getElementById('root')!);
