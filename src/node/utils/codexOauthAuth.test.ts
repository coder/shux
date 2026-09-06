import { describe, it, expect } from "bun:test";

import {
  parseCodexOauthAuth,
  getCodexOauthAccounts,
  getCodexOauthAccountId,
  getCodexOauthAuth,
  isCodexOauthAuthExpired,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountIdFromToken,
  extractAccountIdFromTokens,
} from "./codexOauthAuth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a claims object into a fake JWT (header.payload.signature). */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

// ---------------------------------------------------------------------------
// parseCodexOauthAuth
// ---------------------------------------------------------------------------

describe("parseCodexOauthAuth", () => {
  it("accepts a valid object with all required fields", () => {
    const input = {
      type: "oauth" as const,
      access: "at_123",
      refresh: "rt_456",
      expires: Date.now() + 60_000,
    };
    const result = parseCodexOauthAuth(input);
    expect(result).toEqual(input);
  });

  it("accepts a valid object with optional accountId", () => {
    const input = {
      type: "oauth" as const,
      access: "at_123",
      refresh: "rt_456",
      expires: Date.now() + 60_000,
      accountId: "acct_abc",
    };
    const result = parseCodexOauthAuth(input);
    expect(result).toEqual(input);
  });

  it("preserves credentials with missing or malformed login IDs", () => {
    const auth = { type: "oauth" as const, access: "access", refresh: "refresh", expires: 1000 };
    expect(parseCodexOauthAuth(auth)).not.toBeNull();
    const credentialId = "1c9c50b0-d777-4dd2-998c-09c156ba9754";
    expect(parseCodexOauthAuth({ ...auth, credentialId })?.credentialId).toBe(credentialId);
    for (const invalid of [null, "", "not-a-uuid", 42]) {
      const stored = { ...auth, credentialId: invalid };
      expect(parseCodexOauthAuth(stored)).toEqual(auth);
      expect(
        getCodexOauthAccounts({
          codexOauthAccounts: { work: { label: "Work", credentials: stored } },
        })
      ).toHaveLength(1);
      expect(stored.credentialId).toBe(invalid);
    }
  });

  it("retains only a legacy alias that matches the current credential ID", () => {
    const credentialId = "1c9c50b0-d777-4dd2-998c-09c156ba9754";
    const auth = {
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 1000,
      credentialId,
    };
    for (const legacyCredentialId of [
      credentialId,
      undefined,
      null,
      "",
      42,
      "not-a-uuid",
      "50e00a32-b964-4ce2-b131-6b53356ce2db",
    ]) {
      const parsed = parseCodexOauthAuth({ ...auth, legacyCredentialId });
      expect(parsed?.access).toBe(auth.access);
      expect(parsed?.legacyCredentialId).toBe(
        legacyCredentialId === credentialId ? credentialId : undefined
      );
    }
    expect(
      parseCodexOauthAuth({ ...auth, credentialId: undefined, legacyCredentialId: credentialId })
        ?.legacyCredentialId
    ).toBeUndefined();
  });

  it("preserves only the supported invalid credential marker", () => {
    const auth = { type: "oauth" as const, access: "access", refresh: "refresh", expires: 1000 };
    const marked = parseCodexOauthAuth({ ...auth, invalidReason: "invalid_grant" });
    expect(marked).toEqual({ ...auth, invalidReason: "invalid_grant" });
    expect(getCodexOauthAccounts({ codexOauth: marked })).toHaveLength(1);
    for (const invalidReason of [null, "other", 42]) {
      expect(parseCodexOauthAuth({ ...auth, invalidReason })).toBeNull();
    }
  });

  it("returns null for non-object values", () => {
    expect(parseCodexOauthAuth(null)).toBeNull();
    expect(parseCodexOauthAuth(undefined)).toBeNull();
    expect(parseCodexOauthAuth("string")).toBeNull();
    expect(parseCodexOauthAuth(42)).toBeNull();
    expect(parseCodexOauthAuth([])).toBeNull();
  });

  it("returns null when type is not 'oauth'", () => {
    expect(
      parseCodexOauthAuth({ type: "api-key", access: "a", refresh: "r", expires: 123 })
    ).toBeNull();
  });

  it("returns null when access is missing or empty", () => {
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "", refresh: "r", expires: 123 })
    ).toBeNull();
    expect(parseCodexOauthAuth({ type: "oauth", refresh: "r", expires: 123 })).toBeNull();
  });

  it("returns null when refresh is missing or empty", () => {
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "", expires: 123 })
    ).toBeNull();
  });

  it("returns null when expires is not a finite number", () => {
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "r", expires: NaN })
    ).toBeNull();
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "r", expires: Infinity })
    ).toBeNull();
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "r", expires: "soon" })
    ).toBeNull();
  });

  it("returns null when accountId is present but empty string", () => {
    expect(
      parseCodexOauthAuth({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 123,
        accountId: "",
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isCodexOauthAuthExpired
// ---------------------------------------------------------------------------

describe("isCodexOauthAuthExpired", () => {
  const base = { type: "oauth" as const, access: "a", refresh: "r" };

  it("returns false when token is not yet expired (with default skew)", () => {
    // Token expires 60s from now, default skew is 30s → not expired
    const auth = { ...base, expires: Date.now() + 60_000 };
    expect(isCodexOauthAuthExpired(auth)).toBe(false);
  });

  it("returns true when token is within the skew window", () => {
    // Token expires in 20s, default skew 30s → expired
    const now = Date.now();
    const auth = { ...base, expires: now + 20_000 };
    expect(isCodexOauthAuthExpired(auth, { nowMs: now })).toBe(true);
  });

  it("returns true when token is already past expiry", () => {
    const auth = { ...base, expires: Date.now() - 1000 };
    expect(isCodexOauthAuthExpired(auth)).toBe(true);
  });

  it("respects custom skew", () => {
    const now = 1_000_000;
    const auth = { ...base, expires: now + 5_000 };
    // With 0 skew, not expired
    expect(isCodexOauthAuthExpired(auth, { nowMs: now, skewMs: 0 })).toBe(false);
    // With 10s skew, expired
    expect(isCodexOauthAuthExpired(auth, { nowMs: now, skewMs: 10_000 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseJwtClaims
// ---------------------------------------------------------------------------

describe("parseJwtClaims", () => {
  it("decodes a valid JWT payload", () => {
    const claims = { sub: "user_123", iss: "https://auth.openai.com" };
    const token = fakeJwt(claims);
    expect(parseJwtClaims(token)).toEqual(claims);
  });

  it("returns null for tokens with wrong number of parts", () => {
    expect(parseJwtClaims("")).toBeNull();
    expect(parseJwtClaims("one.two")).toBeNull();
    expect(parseJwtClaims("a.b.c.d")).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    const header = Buffer.from("{}").toString("base64url");
    const payload = Buffer.from('"just a string"').toString("base64url");
    expect(parseJwtClaims(`${header}.${payload}.sig`)).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(parseJwtClaims("a.!!!invalid!!!.c")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAccountIdFromClaims
// ---------------------------------------------------------------------------

describe("extractAccountIdFromClaims", () => {
  it("prefers direct chatgpt_account_id claim", () => {
    const claims = {
      chatgpt_account_id: "direct_id",
      "https://api.openai.com/auth": { chatgpt_account_id: "nested_id" },
      organizations: [{ id: "org_id" }],
    };
    expect(extractAccountIdFromClaims(claims)).toBe("direct_id");
  });

  it("falls back to nested auth namespace", () => {
    const claims = {
      "https://api.openai.com/auth": { chatgpt_account_id: "nested_id" },
      organizations: [{ id: "org_id" }],
    };
    expect(extractAccountIdFromClaims(claims)).toBe("nested_id");
  });

  it("falls back to organizations[0].id", () => {
    const claims = {
      organizations: [{ id: "org_id" }],
    };
    expect(extractAccountIdFromClaims(claims)).toBe("org_id");
  });

  it("returns null when no account id is found", () => {
    expect(extractAccountIdFromClaims({})).toBeNull();
    expect(extractAccountIdFromClaims({ organizations: [] })).toBeNull();
    expect(
      extractAccountIdFromClaims({ "https://api.openai.com/auth": "not an object" })
    ).toBeNull();
  });

  it("skips empty string values", () => {
    expect(extractAccountIdFromClaims({ chatgpt_account_id: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAccountIdFromToken / extractAccountIdFromTokens
// ---------------------------------------------------------------------------

describe("extractAccountIdFromToken", () => {
  it("extracts account id from a JWT", () => {
    const token = fakeJwt({ chatgpt_account_id: "from_jwt" });
    expect(extractAccountIdFromToken(token)).toBe("from_jwt");
  });

  it("returns null for an invalid token", () => {
    expect(extractAccountIdFromToken("not-a-jwt")).toBeNull();
  });
});

describe("extractAccountIdFromTokens", () => {
  it("prefers id_token over access token", () => {
    const idToken = fakeJwt({ chatgpt_account_id: "from_id_token" });
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access_token" });
    expect(extractAccountIdFromTokens({ accessToken, idToken })).toBe("from_id_token");
  });

  it("falls back to access token when id_token is missing", () => {
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access_token" });
    expect(extractAccountIdFromTokens({ accessToken })).toBe("from_access_token");
  });

  it("falls back to access token when id_token has no account id", () => {
    const idToken = fakeJwt({ sub: "user" });
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access_token" });
    expect(extractAccountIdFromTokens({ accessToken, idToken })).toBe("from_access_token");
  });
});

describe("Codex OAuth account slots", () => {
  const legacy = { type: "oauth", access: "legacy", refresh: "legacy-refresh", expires: 1000 };
  const work = {
    type: "oauth",
    access: "work",
    refresh: "work-refresh",
    expires: 2000,
    accountId: "remote-chatgpt-id",
  };

  it("reads the legacy slot and named slots with separate local identities", () => {
    const config = {
      codexOauth: legacy,
      codexOauthLabel: "Personal",
      codexOauthAccounts: { work: { label: "Work", credentials: work } },
    };
    expect(getCodexOauthAccounts(config).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "default", label: "Personal" },
      { id: "work", label: "Work" },
    ]);
    expect(getCodexOauthAuth(config, "work")?.accountId).toBe("remote-chatgpt-id");
    expect(getCodexOauthAuth(config, "remote-chatgpt-id")).toBeNull();
    expect(getCodexOauthAuth(config)?.access).toBe("legacy");
  });

  it("uses explicit selection before the global default and never substitutes missing slots", () => {
    const config = {
      codexOauth: legacy,
      codexOauthAccounts: { work: { label: "Work", credentials: work } },
      codexOauthDefaultAccountId: "work",
    };
    expect(getCodexOauthAuth(config)?.access).toBe("work");
    expect(getCodexOauthAuth(config, "default")?.access).toBe("legacy");
    expect(getCodexOauthAuth(config, "missing")).toBeNull();
    expect(getCodexOauthAuth({ ...config, codexOauthDefaultAccountId: "missing" })).toBeNull();
    expect(getCodexOauthAccountId(undefined)).toBe("default");
    expect(getCodexOauthAccountId(config, "missing")).toBe("missing");
  });

  it.each([
    { damage: "missing", label: undefined },
    { damage: "null", label: null },
    { damage: "number", label: 42 },
    { damage: "boolean", label: false },
    { damage: "object", label: {} },
    { damage: "array", label: [] },
    { damage: "empty", label: "" },
    { damage: "whitespace", label: " \t\n" },
  ])("preserves named credentials when the label is $damage", ({ label }) => {
    const auth = { ...work, access: "damaged-label-access" };
    const config = {
      codexOauth: legacy,
      codexOauthDefaultAccountId: "damaged",
      codexOauthAccounts: {
        damaged: { label, credentials: auth },
        work: { label: " Work ", credentials: work },
      },
    };
    expect(getCodexOauthAccounts(config).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "default", label: "Default" },
      { id: "damaged", label: "damaged" },
      { id: "work", label: "Work" },
    ]);
    expect(getCodexOauthAuth(config)).toMatchObject(auth);
    expect(getCodexOauthAuth(config, "damaged")).toMatchObject(auth);
  });

  it("rejects malformed named credentials regardless of label validity", () => {
    const config = {
      codexOauthAccounts: {
        missingAuth: {},
        invalidType: { label: "Valid label", credentials: { ...work, type: "apiKey" } },
        invalidAccess: { label: 42, credentials: { ...work, access: null } },
        invalidRefresh: { credentials: { ...work, refresh: "" } },
        invalidExpiry: { label: " ", credentials: { ...work, expires: Infinity } },
        work: { label: "Work", credentials: work },
      },
    };
    expect(getCodexOauthAccounts(config).map(({ id }) => id)).toEqual(["work"]);
    for (const id of Object.keys(config.codexOauthAccounts)) {
      if (id !== "work") expect(getCodexOauthAuth(config, id)).toBeNull();
    }
  });

  it("excludes stored IDs that cannot pass account mutation validation", () => {
    const invalidIds = ["", "__proto__", "constructor", "prototype", "../bad", "x".repeat(201)];
    const accounts = Object.fromEntries(
      invalidIds.map((id) => [id, { label: "Invalid", credentials: work }])
    );
    const config = {
      codexOauthAccounts: { ...accounts, work: { label: "Work", credentials: work } },
    };
    expect(getCodexOauthAccounts(config).map((account) => account.id)).toEqual(["work"]);
    for (const id of invalidIds) expect(getCodexOauthAuth(config, id)).toBeNull();
    expect(getCodexOauthAuth({ ...config, codexOauthDefaultAccountId: "../bad" })).toBeNull();
  });

  it("filters malformed slots without accepting a duplicate legacy slot", () => {
    const config = {
      codexOauth: legacy,
      codexOauthAccounts: {
        default: { label: "Duplicate", credentials: work },
        broken: { label: "Broken", credentials: {} },
        blank: { label: " ", credentials: null },
        work: { label: "Work", credentials: work },
      },
    };
    expect(getCodexOauthAccounts(config).map((account) => account.id)).toEqual(["default", "work"]);
    expect(getCodexOauthAccounts(null)).toEqual([]);
    expect(getCodexOauthAccounts({ codexOauthAccounts: [] })).toEqual([]);
  });
});
