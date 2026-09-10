import { randomBytes } from "crypto";

export type ResolvedAuthToken =
  | { mode: "disabled"; token: "" }
  | { mode: "enabled"; token: string; source: "cli" | "env" | "generated" };

/**
 * Resolve the auth token for `xum server` from CLI flags, env vars, or generate one.
 *
 * Precedence: --no-auth > --auth-token > MUX_SERVER_AUTH_TOKEN > auto-generated.
 */
export function resolveServerAuthToken(opts: {
  noAuth: boolean;
  cliToken: string | undefined;
  envToken: string | undefined;
  /** Injectable for deterministic testing. */
  randomBytesFn?: (n: number) => Buffer;
}): ResolvedAuthToken {
  if (opts.noAuth) {
    return { mode: "disabled", token: "" };
  }

  const cli = opts.cliToken?.trim();
  if (cli) {
    return { mode: "enabled", token: cli, source: "cli" };
  }

  const env = opts.envToken?.trim();
  if (env) {
    return { mode: "enabled", token: env, source: "env" };
  }

  const gen = (opts.randomBytesFn ?? randomBytes)(32).toString("hex");
  return { mode: "enabled", token: gen, source: "generated" };
}
