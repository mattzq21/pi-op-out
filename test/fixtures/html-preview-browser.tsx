import { render } from 'solid-js/web';
import { Message } from '../../clients/ui/components/Message';
import '../../clients/ui/styles.css';

/** One saved HTML preview message, as the piop-html-preview extension writes it. */
const details = await (window as any).previewDetails();
document.title = 'Piop';
render(() => <main><Message message={{ id: 'preview', role: 'custom', customType: 'piop-html-preview', content: details?.title ?? '', details }} /></main>, document.getElementById('root')!);
