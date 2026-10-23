import { render } from 'solid-js/web';
import { ZoomableImage } from '../../clients/ui/components/ZoomableImage';
import '../../clients/ui/styles.css';

/** A 2000×1200 chart image, larger than the test window, and an image that cannot load. */
const canvas = document.createElement('canvas');
canvas.width = 2000; canvas.height = 1200;
const context = canvas.getContext('2d')!;
context.fillStyle = '#3366cc'; context.fillRect(0, 0, 2000, 1200);
(window as any).imageErrors = 0;

render(() => <main>
  <ZoomableImage src={canvas.toDataURL('image/png')} alt="Chart" />
  <ZoomableImage src="data:image/png;base64,broken" alt="Missing chart" onError={() => { (window as any).imageErrors++; }} />
</main>, document.getElementById('root')!);
