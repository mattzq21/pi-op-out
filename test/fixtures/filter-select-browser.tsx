import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { FilterSelect, type FilterOption } from '../../clients/ui/components/FilterSelect';

const names = [...Array.from({ length: 40 }, (_, index) => `Provider: Model ${index}`), ...Array.from({ length: 20 }, (_, index) => `Solace: Sol ${index}`), 'OpenAI: GPT-6.1 Sol Pro', 'OpenAI: GPT-6.1 Sol (base)', 'Upstage: Solar Mini 4', 'Upstage: Solar Pro 4', 'gpt-6-sol', 'gpt-6-sol--fast', 'gpt-6.1-sol--fast', 'gpt-6.1-sol', 'zeta'];
const options: FilterOption[] = names.map(name => ({ value: name, label: name, search: name }));

function Example() {
  const [value, setValue] = createSignal('gpt-6.1-sol');
  return <div style={{ width: '200px', margin: '20px' }}><FilterSelect label="Model" filterPlaceholder="Filter" value={value()} options={options} onChange={setValue} /></div>;
}

render(() => <Example />, document.getElementById('app')!);
