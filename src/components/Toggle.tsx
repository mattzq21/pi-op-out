export function Toggle(componentProps: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return <button type="button" role="switch" aria-checked={componentProps.checked} aria-label={componentProps.label} disabled={componentProps.disabled} title={componentProps.title} class={`toggle ${componentProps.checked ? "on" : ""}`} onClick={() => componentProps.onChange(!componentProps.checked)}><span /></button>;
}
