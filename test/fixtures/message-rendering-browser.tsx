import { render } from 'solid-js/web';
import { Message } from '../../clients/ui/components/Message';
import { MessageFileContext } from '../../clients/ui/lib/messageFiles';
import '../../clients/ui/styles.css';

const kind = new URLSearchParams(location.search).get("kind");
const html = '<script>window.injected = "script"</script>\n\nPlain <b onclick="window.injected = \'click\'">bold</b> <img src="x" onerror="window.injected = \'image\'">';

render(() => <>
  <button>Outside message</button>
  <main style={{ width: '700px', height: '400px', overflow: 'auto', margin: '80px auto' }}>
  <MessageFileContext.Provider value={{ hostId: () => "local", cwd: () => "/repo" }}>
  <Message message={kind === "link" ? { id: "link", role: "assistant", content: "[link](https://example.com)" } : kind === "file" ? { id: "file", role: "assistant", content: "See [app](src/app.py:12) and /tmp/notes.md" } : kind === "code" ? { id: 'code', role: 'assistant', content: '```js\nconst answer = 42;\n```' } : kind === "table" ? { id: 'table', role: 'assistant', content: 'Intro\n\n| Name | Size |\n| --- | ---: |\n| **a** | 1 |\n\nAfter' } : kind === "html" ? { id: 'html', role: 'assistant', content: html } : { id: 'source', role: 'user', content: '**source**' }} />
  </MessageFileContext.Provider>
  {kind === 'link' && <div aria-hidden="true" style={{ height: '1200px' }} />}
</main></>, document.getElementById('root')!);
