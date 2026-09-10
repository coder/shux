import { beforeEach, describe, expect, it } from "bun:test";

import type {
  SshCredentialPromptRequest,
  SshHostKeyPromptRequest,
  SshPromptRequest,
} from "@/common/orpc/schemas/ssh";
import { SshPromptService } from "./sshPromptService";

/** Short timeout for tests — avoids waiting the real 60s. */
const TEST_TIMEOUT_MS = 20;

const HOST_KEY_REQUEST_PARAMS: Omit<SshHostKeyPromptRequest, "requestId"> = {
  kind: "host-key",
  host: "example.com",
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:abcdef",
  prompt: "Trust host key?",
};

const CREDENTIAL_REQUEST_PARAMS: Omit<SshCredentialPromptRequest, "requestId"> = {
  kind: "credential",
  prompt: "Password for user@example.com:",
  secret: true,
};

function waitForTimeout(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, TEST_TIMEOUT_MS * 3);
  });
}

describe("SshPromptService", () => {
  let service: SshPromptService;
  let requests: SshPromptRequest[];
  let releaseResponder: () => void;

  beforeEach(() => {
    service = new SshPromptService(TEST_TIMEOUT_MS);
    requests = [];
    service.on("request", (req: SshPromptRequest) => {
      requests.push(req);
    });
    releaseResponder = service.registerInteractiveResponder();
  });

  it("resolves on explicit respond", async () => {
    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, "yes");

    const result = await verification;
    expect(result).toBe("yes");
  });

  it("resolves empty response on timeout", async () => {
    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    await waitForTimeout();

    const result = await verification;
    expect(result).toBe("");
  });

  it("deduped waiters all resolve on respond", async () => {
    const verification1 = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const verification2 = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const verification3 = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, "yes");

    const results = await Promise.all([verification1, verification2, verification3]);
    expect(results).toEqual(["yes", "yes", "yes"]);
  });

  it("deduped waiters all resolve empty response on timeout", async () => {
    const verification1 = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const verification2 = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const verification3 = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    await waitForTimeout();

    const results = await Promise.all([verification1, verification2, verification3]);
    expect(results).toEqual(["", "", ""]);
  });

  it("late respond after timeout is a no-op", async () => {
    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    await waitForTimeout();
    const result = await verification;
    expect(result).toBe("");

    expect(() => {
      service.respond(requestId, "yes");
    }).not.toThrow();
  });

  it("host can be re-requested after timeout cleanup", async () => {
    const firstVerification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    await waitForTimeout();
    const firstResult = await firstVerification;
    expect(firstResult).toBe("");

    const secondVerification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    expect(requests).toHaveLength(2);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);

    service.respond(requests[1].requestId, "yes");

    const secondResult = await secondVerification;
    expect(secondResult).toBe("yes");
  });

  it("returns immediately with empty response when no responders", async () => {
    releaseResponder();

    const result = await service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    expect(result).toBe("");
    expect(requests).toHaveLength(0);
  });

  it("emits request when responder is registered", async () => {
    releaseResponder();
    const release = service.registerInteractiveResponder();

    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, "yes");

    const result = await verification;
    expect(result).toBe("yes");

    release();
  });

  it("keeps pending verification alive when last responder disconnects", async () => {
    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    expect(requests).toHaveLength(1);

    // Simulate renderer disconnect — last responder released while prompt pending.
    releaseResponder();

    // Re-register before responding (simulates reconnect).
    const release2 = service.registerInteractiveResponder();
    service.respond(requests[0].requestId, "yes");

    // Pending request survived the responder gap and was accepted.
    const result = await verification;
    expect(result).toBe("yes");

    release2();
  });

  it("joins an existing deduped request while responders are temporarily disconnected", async () => {
    const v1 = service.requestPrompt({ ...HOST_KEY_REQUEST_PARAMS, dedupeKey: "example.com:22" });
    expect(requests).toHaveLength(1);

    releaseResponder();
    const v2 = service.requestPrompt({ ...HOST_KEY_REQUEST_PARAMS, dedupeKey: "example.com:22" });

    expect(requests).toHaveLength(1);

    const release2 = service.registerInteractiveResponder();
    service.respond(requests[0].requestId, "yes");

    const results = await Promise.all([v1, v2]);
    expect(results).toEqual(["yes", "yes"]);
    release2();
  });

  it("times out pending verification even after all responders disconnect", async () => {
    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    expect(requests).toHaveLength(1);

    releaseResponder();

    // No responder to approve — timeout should still fire and reject.
    await waitForTimeout();
    const result = await verification;
    expect(result).toBe("");
  });

  it("double-release is safe", () => {
    releaseResponder();

    const release = service.registerInteractiveResponder();

    expect(() => {
      release();
      release();
    }).not.toThrow();
  });

  it("does not coalesce when dedupeKey differs", async () => {
    const v1 = service.requestPrompt({ ...HOST_KEY_REQUEST_PARAMS, dedupeKey: "example.com:22" });
    const v2 = service.requestPrompt({ ...HOST_KEY_REQUEST_PARAMS, dedupeKey: "example.com:2222" });

    expect(requests).toHaveLength(2);

    service.respond(requests[0].requestId, "yes");
    service.respond(requests[1].requestId, "no");

    expect(await v1).toBe("yes");
    expect(await v2).toBe("no");
  });

  it("coalesces when dedupeKey matches", async () => {
    const v1 = service.requestPrompt({ ...HOST_KEY_REQUEST_PARAMS, dedupeKey: "example.com:22" });
    const v2 = service.requestPrompt({ ...HOST_KEY_REQUEST_PARAMS, dedupeKey: "example.com:22" });

    expect(requests).toHaveLength(1);

    service.respond(requests[0].requestId, "yes");

    const results = await Promise.all([v1, v2]);
    expect(results).toEqual(["yes", "yes"]);
  });

  it("does not coalesce credential prompts", async () => {
    const v1 = service.requestPrompt(CREDENTIAL_REQUEST_PARAMS);
    const v2 = service.requestPrompt(CREDENTIAL_REQUEST_PARAMS);

    expect(requests).toHaveLength(2);
    expect(requests[0].kind).toBe("credential");
    expect(requests[1].kind).toBe("credential");

    service.respond(requests[0].requestId, "secret-one");
    service.respond(requests[1].requestId, "secret-two");

    expect(await v1).toBe("secret-one");
    expect(await v2).toBe("secret-two");
  });

  it("replays pending requests to late subscribers", async () => {
    // Request emitted BEFORE subscriber connects
    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    expect(requests).toHaveLength(1);
    const requestId = requests[0].requestId;

    // Late subscriber should see the pending request via snapshot
    const lateRequests: SshPromptRequest[] = [];
    const { snapshot, unsubscribe } = service.subscribeRequests((req) => {
      lateRequests.push(req);
    });

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].requestId).toBe(requestId);
    expect(snapshot[0].kind).toBe("host-key");

    unsubscribe();
    service.respond(requestId, "yes");
    await verification;
  });

  it("does not replay resolved requests", async () => {
    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    service.respond(requestId, "yes");
    await verification;

    // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op listener; we only care about the snapshot
    const { snapshot, unsubscribe } = service.subscribeRequests(() => {});
    expect(snapshot).toHaveLength(0);
    unsubscribe();
  });

  it("emits removed event on timeout", async () => {
    const removedIds: string[] = [];
    service.on("removed", (id: string) => removedIds.push(id));

    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    await waitForTimeout();
    await verification;

    expect(removedIds).toEqual([requestId]);
  });

  it("emits removed event on explicit respond", async () => {
    const removedIds: string[] = [];
    service.on("removed", (id: string) => removedIds.push(id));

    const verification = service.requestPrompt(HOST_KEY_REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    service.respond(requestId, "yes");
    await verification;

    expect(removedIds).toEqual([requestId]);
  });
});
