import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { installTooltips } from '../../clients/ui/lib/tooltips.ts';

test('a touch tap toggles tooltips on anchors marked for tapping', () => {
  const dom = installDom();
  const remove = installTooltips();
  try {
    document.body.innerHTML = '<span id="tap" data-tooltip="Tapped" data-tooltip-tap></span><span id="plain" data-tooltip="Plain"></span>';
    const tap = (id, pointerType = 'touch') => { const target = document.getElementById(id); const down = new MouseEvent('pointerdown', { bubbles: true }); Object.defineProperty(down, 'pointerType', { value: pointerType }); target.dispatchEvent(down); target.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
    const tooltip = () => document.querySelector('.app-tooltip')?.textContent;
    tap('tap'); assert.equal(tooltip(), 'Tapped');
    tap('tap'); assert.equal(tooltip(), undefined);
    tap('plain'); assert.equal(tooltip(), undefined);
    tap('tap', 'mouse'); assert.equal(tooltip(), undefined);
  } finally { remove(); dom.restore(); }
});
