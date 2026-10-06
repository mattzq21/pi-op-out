export function Toggle(componentProps: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return <button type="button" role="switch" aria-checked={componentProps.checked} aria-label={componentProps.label} disabled={componentProps.disabled} data-tooltip={componentProps.title} class={`toggle ${componentProps.checked ? "on" : ""}`} onClick={() => componentProps.onChange(!componentProps.checked)}><span /></button>;
}
