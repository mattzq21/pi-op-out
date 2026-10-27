/** Shows the drag cursor and stops text selection on the whole page while a resizer is dragged; the returned function restores the previous style. WebKitGTK knows user-select only by its prefixed name. */
export function holdBodyDragStyle(cursor: string) {
  const style = document.body.style;
  const previous = ["cursor", "user-select", "-webkit-user-select"].map(name => [name, style.getPropertyValue(name)] as const);
  style.setProperty("cursor", cursor);
  style.setProperty("user-select", "none");
  style.setProperty("-webkit-user-select", "none");

  return () => { for (const [name, value] of previous) style.setProperty(name, value); };
}
