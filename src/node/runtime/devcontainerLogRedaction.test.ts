import { describe, expect, it } from "bun:test";
import {
  redactDevcontainerArgsForLog,
  SENSITIVE_REMOTE_ENV_KEYS,
} from "./devcontainerLogRedaction";

describe("redactDevcontainerArgsForLog", () => {
  it("redacts every sensitive --remote-env key", () => {
    for (const key of SENSITIVE_REMOTE_ENV_KEYS) {
      const args = ["exec", "--remote-env", `${key}=super-secret-value`];
      expect(redactDevcontainerArgsForLog(args)).toEqual([
        "exec",
        "--remote-env",
        `${key}=<redacted>`,
      ]);
    }
  });

  it("leaves non-sensitive --remote-env keys unchanged", () => {
    const args = ["exec", "--remote-env", "GIT_AUTHOR_NAME=Xum Tester"];
    expect(redactDevcontainerArgsForLog(args)).toEqual(args);
  });

  it("returns args unchanged when there are no --remote-env entries", () => {
    const args = ["up", "--workspace-folder", "/tmp/workspace"];
    expect(redactDevcontainerArgsForLog(args)).toEqual(args);
  });

  it("handles mixed sensitive and non-sensitive --remote-env entries", () => {
    const args = [
      "exec",
      "--workspace-folder",
      "/workspace",
      "--remote-env",
      "GH_TOKEN=shhh",
      "--remote-env",
      "GIT_AUTHOR_NAME=Xum Tester",
      "--remote-env",
      "CODER_AGENT_TOKEN=super-secret",
      "--",
      "/bin/sh",
    ];

    expect(redactDevcontainerArgsForLog(args)).toEqual([
      "exec",
      "--workspace-folder",
      "/workspace",
      "--remote-env",
      "GH_TOKEN=<redacted>",
      "--remote-env",
      "GIT_AUTHOR_NAME=Xum Tester",
      "--remote-env",
      "CODER_AGENT_TOKEN=<redacted>",
      "--",
      "/bin/sh",
    ]);
  });
});
