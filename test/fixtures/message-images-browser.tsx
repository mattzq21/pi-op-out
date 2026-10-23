import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { Message } from '../../clients/ui/components/Message';
import '../../clients/ui/styles.css';

const [assistant, setAssistant] = createSignal(false);
render(() => <>
  <button onClick={() => setAssistant(true)}>Show assistant image</button>
  <main style={{ width: '700px', margin: '80px auto' }}>
    <Message message={assistant() ? { id: 'assistant', role: 'assistant', content: '![](https://example.com/image.png)' } : {
      id: 'user', role: 'user', content: [
        { type: 'text', text: '![external](https://example.com/image.png)' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' },
        { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' },
        { type: 'image', mimeType: 'image/jpeg', data: '' },
      ],
    }} />
  </main>
</>, document.getElementById('root')!);
