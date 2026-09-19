import type { Model } from "../types";

export function providerAccount(provider: string) {
  const match = provider.match(/^(.*)--piop-account-(\d+)$/);
  return { provider: match?.[1] ?? provider, number: match ? Number(match[2]) : 1 };
}
export function providerAccountLabel(provider: string) {
  const account = providerAccount(provider);
  return `${account.provider} #${account.number}`;
}
export function accountModelName(model: Pick<Model, "provider" | "id" | "name">) {
  return `${(model.name || model.id).replace(/ #\d+$/, "")} #${providerAccount(model.provider).number}`;
}
