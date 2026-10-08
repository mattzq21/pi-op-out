import type { Model } from "../types";

export function providerAccount(provider: string) {
  const match = provider.match(/^(.*)--piop-account-(\d+)$/);

  return { provider: match?.[1] ?? provider, number: match ? Number(match[2]) : 1 };
}

export function providerAccountLabel(provider: string) {
  const account = providerAccount(provider);

  return `${account.provider} #${account.number}`;
}

type NamedModel = Pick<Model, "provider" | "id" | "name">;

export function accountModelNameLookup(models: readonly NamedModel[]) {
  const providers = new Map<string, Map<string, Set<string>>>();

  for (const model of models) {
    const base = providerAccount(model.provider).provider;
    let accounts = providers.get(model.id);

    if (!accounts) providers.set(model.id, accounts = new Map());
    let names = accounts.get(base);

    if (!names) accounts.set(base, names = new Set());
    names.add(model.provider);
  }

  return (model: NamedModel) => {
    const account = providerAccount(model.provider);
    const names = providers.get(model.id)?.get(account.provider);
    const duplicate = names && (names.size > 1 || !names.has(model.provider));
    const name = (model.name || model.id).replace(/ #\d+$/, "");

    return duplicate ? `${name} #${account.number}` : name;
  };
}
