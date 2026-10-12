/** Copies text. Android WebView refuses the Clipboard API, so a refusal falls back to the copy command. */
export async function copyText(text: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
    await navigator.clipboard.writeText(text);
  } catch (reason) {
    if (!copyWithCommand(text)) throw reason;
  }
}

function copyWithCommand(text: string) {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.cssText = "position: fixed; top: 0; left: 0; opacity: 0; pointer-events: none;";
  document.body.append(area);
  area.select();

  try { return document.execCommand("copy"); }
  finally { area.remove(); focused?.focus({ preventScroll: true }); }
}
