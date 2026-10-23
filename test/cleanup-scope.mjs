export function cleanupScope(t) {
  const callbacks = [];
  t.after(async () => {
    const errors = [];
    for (const callback of callbacks) {
      try { await callback(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n\n'));
  });
  return { after(callback) { callbacks.push(callback); } };
}
