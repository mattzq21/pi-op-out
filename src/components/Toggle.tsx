export function Toggle({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} title={title} className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}
