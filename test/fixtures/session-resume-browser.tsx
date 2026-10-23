import { createRoot, createSignal } from 'solid-js';
import { initializeSessionResume, restoredSessionTarget, useSessionResume } from '../../clients/ui/lib/sessionResume';

await initializeSessionResume();
createRoot(() => {
  const [selection, setSelection] = createSignal({ ready: false, saved: false, target: {} });
  useSessionResume(selection);
  window.selectResume = value => setSelection(value);
});
window.resumeTarget = fallback => restoredSessionTarget(fallback);
document.getElementById('root')!.textContent = 'Resume ready';
