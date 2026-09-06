import type { ProviderConfigInfo } from "@/common/orpc/types";

type Account = Pick<NonNullable<ProviderConfigInfo["codexOauthAccounts"]>[number], "id" | "label">;

/** Disambiguate duplicate labels without changing stored names or account IDs. */
export function formatCodexAccountLabel(account: Account, accounts: readonly Account[]): string {
  const duplicate = accounts.some(
    (other) => other.id !== account.id && other.label === account.label
  );
  return duplicate ? account.label + " (" + account.id + ")" : account.label;
}
