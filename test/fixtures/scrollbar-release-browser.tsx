import { installScrollbarRelease } from '../../clients/ui/lib/scrollbarRelease';
import '../../clients/ui/index.css';

document.getElementById('root')!.innerHTML = '<div id="scroller" style="position:absolute;left:0;top:0;width:400px;height:400px;overflow-y:auto"><div style="height:4000px"></div></div>';
installScrollbarRelease();
