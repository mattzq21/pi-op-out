import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import '../../clients/ui/styles.css';

mockWindows('main');
mockIPC((command, args) => window.storageCommand(command, args), { shouldMockEvents: true });
const { StorageSettings } = await import('../../clients/ui/components/StorageSettings');
render(() => <main style={{ width: '900px', margin: '30px auto' }}><StorageSettings /></main>, document.getElementById('root')!);
