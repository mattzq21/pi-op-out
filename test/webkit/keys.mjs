const named = {
  Cancel: '\uE001', Help: '\uE002', Backspace: '\uE003', Tab: '\uE004', Clear: '\uE005', Enter: '\uE007', Shift: '\uE008', ShiftLeft: '\uE008',
  Control: '\uE009', ControlLeft: '\uE009', ControlOrMeta: '\uE009', Alt: '\uE00A', AltLeft: '\uE00A', Pause: '\uE00B', Escape: '\uE00C', Space: ' ',
  PageUp: '\uE00E', PageDown: '\uE00F', End: '\uE010', Home: '\uE011', ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014',
  ArrowDown: '\uE015', Insert: '\uE016', Delete: '\uE017', Meta: '\uE03D', MetaLeft: '\uE03D', ShiftRight: '\uE050', ControlRight: '\uE051',
  AltRight: '\uE052', MetaRight: '\uE053', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '\u0060',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", NumpadEnter: '\uE007',
};
for (let index = 1; index <= 12; index++) named['F' + index] = String.fromCharCode(0xE031 + index - 1);

export function keyValue(key) {
  if (Object.hasOwn(named, key)) return named[key];
  if (/^Key[A-Z]$/.test(key)) return key.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(key)) return key.slice(5);
  if ([...key].length === 1) return key;
  throw new Error('Unknown key: "' + key + '"');
}

export function shortcutKeys(shortcut) {
  const parts = [];
  let rest = shortcut;
  while (rest.length) {
    const plus = rest.indexOf('+', 1);
    if (plus < 0) { parts.push(rest); break; }
    parts.push(rest.slice(0, plus));
    rest = rest.slice(plus + 1);
  }
  return parts;
}

