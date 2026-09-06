import { describe, expect, it } from "bun:test";
import { redactConfigDocument, REDACTED_SECRET_VALUE } from "./configRedaction";

describe("Codex account redaction", () => {
  it("protects named credentials through the legacy generic redaction rule", () => {
    const credentials = {
      type: "oauth",
      access: "private-access",
      refresh: "private-refresh",
      accountId: "private-chatgpt-account",
      credentialId: "eb5beccb-f8a9-4dc0-b8ce-2bd2954f4e42",
      expires: 12345,
    };
    const accounts = { work: { label: "Work account", credentials } };
    // Commit 5605e7852 has the same generic rules, without the codexOauthAccounts explicit key.
    // An unknown container exercises those rules without the new account-name protection.
    const document = { openai: { futureAccountSlots: accounts } };
    const redacted = redactConfigDocument("providers", document);
    expect(redacted).toEqual({
      openai: {
        futureAccountSlots: {
          work: { label: "Work account", credentials: REDACTED_SECRET_VALUE },
        },
      },
    });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      credentials.access,
      credentials.refresh,
      credentials.accountId,
      credentials.credentialId,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("accountId");
    expect(serialized).not.toContain("credentialId");
    expect(accounts.work.credentials).toEqual(credentials);
  });

  it("removes all account credentials without changing the source document", () => {
    const auth = {
      type: "oauth",
      access: "private-access",
      refresh: "private-refresh",
      expires: 12345,
    };
    const document = {
      openai: {
        codexOauth: auth,
        codexOauthAccounts: { work: { label: "Work", credentials: auth } },
        codexOauthDefaultAccountId: "work",
      },
    };

    const redacted = redactConfigDocument("providers", document);
    expect(redacted).toEqual({
      openai: {
        codexOauth: REDACTED_SECRET_VALUE,
        codexOauthAccounts: REDACTED_SECRET_VALUE,
        codexOauthDefaultAccountId: "work",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain(auth.access);
    expect(JSON.stringify(redacted)).not.toContain(auth.refresh);
    expect(document.openai.codexOauthAccounts.work.credentials).toEqual(auth);
  });
});
