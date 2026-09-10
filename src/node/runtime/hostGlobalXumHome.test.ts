import { describe, expect, it } from "bun:test";
import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import { LocalRuntime } from "./LocalRuntime";
import { TestRemoteRuntime } from "./testRemoteRuntime";
import { resolveGlobalRuntime, shouldUseHostGlobalXumFallback } from "./hostGlobalXumHome";

class StubRemoteRuntime extends TestRemoteRuntime {
  constructor(private readonly xumHome: string) {
    super();
  }

  override getXumHome(): string {
    return this.xumHome;
  }
}

describe("hostGlobalXumHome", () => {
  const workspacePath = "/tmp/xum-host-global-home";

  it("falls back to the host local runtime only for SSH legacy ~/.mux", () => {
    const sshRuntime = new StubRemoteRuntime(LEGACY_REMOTE_MUX_HOME);
    expect(shouldUseHostGlobalXumFallback(sshRuntime)).toBe(true);
    expect(resolveGlobalRuntime(sshRuntime, workspacePath)).toBeInstanceOf(LocalRuntime);
  });

  it("keeps Docker /var/mux on the container runtime", () => {
    const dockerRuntime = new StubRemoteRuntime("/var/mux");
    expect(shouldUseHostGlobalXumFallback(dockerRuntime)).toBe(false);
    expect(resolveGlobalRuntime(dockerRuntime, workspacePath)).toBe(dockerRuntime);
  });

  it("keeps local canonical ~/.xum on the workspace runtime", () => {
    const localRuntime = new LocalRuntime(workspacePath);
    expect(localRuntime.getXumHome()).toBe("~/.xum");
    expect(shouldUseHostGlobalXumFallback(localRuntime)).toBe(false);
    expect(resolveGlobalRuntime(localRuntime, workspacePath)).toBe(localRuntime);
  });
});
