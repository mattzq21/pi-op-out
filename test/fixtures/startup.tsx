import '../../clients/ui/main';
import { render } from 'solid-js/web';
import { Markdown } from '../../clients/ui/components/Markdown';

render(() => <Markdown>[Reference](https://example.com)</Markdown>, document.getElementById('sample')!);
