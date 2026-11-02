import { render } from 'solid-js/web';
import { ImageGallery, ZoomableImage } from '../../clients/ui/components/ZoomableImage';
import '../../clients/ui/styles.css';

const canvas = document.createElement('canvas');
canvas.width = 2000; canvas.height = 1200;
const context = canvas.getContext('2d')!;
context.fillStyle = '#3366cc'; context.fillRect(0, 0, 2000, 1200);
(window as any).imageErrors = 0;
const tile = (color: string) => { const image = document.createElement('canvas'); image.width = 300; image.height = 200; const draw = image.getContext('2d')!; draw.fillStyle = color; draw.fillRect(0, 0, 300, 200); return image.toDataURL('image/png'); };

render(() => <main>
  <ZoomableImage src={canvas.toDataURL('image/png')} alt="Chart" />
  <ZoomableImage src="data:image/png;base64,broken" alt="Missing chart" onError={() => { (window as any).imageErrors++; }} />
  <ImageGallery>
    <ZoomableImage src={tile('#cc3333')} alt="First" />
    <ZoomableImage src="data:image/png;base64,broken" alt="Broken" />
    <ZoomableImage src={tile('#33cc33')} alt="Second" />
    <ZoomableImage src={tile('#3333cc')} alt="Third" />
  </ImageGallery>
</main>, document.getElementById('root')!);
