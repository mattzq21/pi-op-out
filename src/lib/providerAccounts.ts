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
export function accountModelName(model: NamedModel, models: readonly NamedModel[]) {
  const account = providerAccount(model.provider);
  const name = (model.name || model.id).replace(/ #\d+$/, "");
  const duplicate = models.some((candidate) => candidate.id === model.id && candidate.provider !== model.provider && providerAccount(candidate.provider).provider === account.provider);
  return duplicate ? `${name} #${account.number}` : name;
}
