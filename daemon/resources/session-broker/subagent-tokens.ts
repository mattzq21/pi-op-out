type Usage = { input?: number; output?: number; cacheWrite?: number };
const amount = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
export const usageTokens = (usage?: Usage) => Math.ceil(amount(usage?.input) + amount(usage?.cacheWrite) + amount(usage?.output));
