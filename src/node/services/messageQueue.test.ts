import { describe, it, expect, beforeEach } from "bun:test";
import { MessageQueue } from "./messageQueue";
import {
  createMuxMessage,
  prepareUserMessageForSend,
  type MuxMessageMetadata,
} from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";
import type { SendMessageOptions } from "@/common/orpc/types";

describe("MessageQueue", () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  describe("restore projection", () => {
    const reviews: ReviewNoteData[] = ["first.ts", "second.ts"].map((filePath) => ({
      filePath,
      lineRange: "1",
      selectedCode: "const value = 1;",
      userNote: `Review ${filePath}`,
    }));
    const file = {
      url: "data:text/plain;base64,dGV4dA==",
      mediaType: "text/plain",
      filename: "notes.txt",
    };
    const options = { model: "test-model", agentId: "exec" };

    it.each([false, true])(
      "restores each enqueue's reviews while preserving dispatch (sealed=%s)",
      (sealed) => {
        const bodies = ["First body\n<review>literal user XML</review>", "Second body"];
        const prepared = bodies.map((text, index) =>
          prepareUserMessageForSend({ text, reviews: [reviews[index]] })
        );
        prepared.forEach((message) =>
          queue.add(
            message.finalText,
            { ...options, muxMetadata: message.metadata, fileParts: [file] },
            { sealed }
          )
        );
        expect(queue.entryCount()).toBe(sealed ? 2 : 1);
        expect(queue.getVisibleDisplayText()).toBe(
          prepared.map((message) => message.finalText).join("\n")
        );
        expect(queue.getVisibleReviews()).toEqual(sealed ? reviews : [reviews[0]]);
        expect(queue.getVisibleRestoreText()).toBe(bodies.join("\n"));
        expect(queue.getVisibleRestoreReviews()).toEqual(reviews);
        expect(queue.getVisibleFileParts()).toEqual([file, file]);
        const resend = prepareUserMessageForSend({
          text: queue.getVisibleRestoreText(),
          reviews: queue.getVisibleRestoreReviews(),
        });
        expect(resend).toEqual(prepareUserMessageForSend({ text: bodies.join("\n"), reviews }));
        const first = queue.dequeueNext();
        expect(first.message).toBe(
          sealed ? prepared[0].finalText : prepared.map((message) => message.finalText).join("\n")
        );
        expect(first.options?.muxMetadata).toEqual(prepared[0].metadata);
        expect(queue.getVisibleRestoreReviews()).toEqual(sealed ? [reviews[1]] : undefined);
        queue.clear();
        expect(queue.getVisibleRestoreText()).toBe("");
        expect(queue.getVisibleRestoreReviews()).toBeUndefined();
      }
    );

    it("strips one prepended prefix, not matching literal body text or later unreviewed adds", () => {
      const prefix = prepareUserMessageForSend({ text: "", reviews }).finalText;
      const body = `${prefix}\n\nLiteral repeated review, kept verbatim`;
      const prepared = prepareUserMessageForSend({ text: body, reviews });
      queue.add(prepared.finalText, { ...options, muxMetadata: prepared.metadata });
      queue.add(body, options);
      expect(queue.getVisibleRestoreText()).toBe(`${body}\n${body}`);
      expect(queue.getVisibleRestoreReviews()).toEqual(reviews);
    });

    it("preserves raw text without the matching prefix and review-only/file-only payloads", () => {
      const raw = "<review>literal</review>\n\nraw user input";
      queue.add(raw, { ...options, muxMetadata: { reviews: [reviews[0]] } });
      const prepared = prepareUserMessageForSend({ text: "", reviews: [reviews[1]] });
      queue.add(prepared.finalText, { ...options, muxMetadata: prepared.metadata });
      queue.add("", { ...options, fileParts: [file], muxMetadata: { reviews: [reviews[0]] } });
      expect(queue.getVisibleRestoreText()).toBe(raw);
      expect(queue.getVisibleRestoreReviews()).toEqual([...reviews, reviews[0]]);
      expect(queue.getVisibleFileParts()).toEqual([file]);
    });

    it("keeps restore records aligned through partial dedupe removals and preserves hidden cancellation", () => {
      reviews.forEach((review, index) => {
        const prepared = prepareUserMessageForSend({ text: `body ${index}`, reviews: [review] });
        queue.addOnce(
          prepared.finalText,
          { ...options, muxMetadata: prepared.metadata },
          `review-${index}`
        );
      });
      queue.add("tail", options);
      queue.removeByDedupeKeyPrefix("review-0");
      expect(queue.getVisibleRestoreText()).toBe("body 1\ntail");
      expect(queue.getVisibleRestoreReviews()).toEqual([reviews[1]]);
      queue.removeByDedupeKeyPrefix("review-1");
      expect(queue.getVisibleRestoreText()).toBe("tail");
      expect(queue.getVisibleRestoreReviews()).toBeUndefined();
      const onCanceled = () => undefined;
      const hidden = prepareUserMessageForSend({ text: "hidden", reviews });
      queue.add(
        hidden.finalText,
        { ...options, muxMetadata: hidden.metadata },
        { synthetic: true, onCanceled }
      );
      expect(queue.getVisibleRestoreText()).toBe("tail");
      expect(queue.getVisibleRestoreReviews()).toBeUndefined();
      expect(queue.getClearCallbacks()).toContainEqual({ onCanceled });
    });

    it("does not throw away input when unvalidated metadata contains malformed reviews", () => {
      expect(queue.add("raw input", { ...options, muxMetadata: { reviews: [{}] } })).toBe(true);
      expect(queue.getVisibleRestoreText()).toBe("raw input");
    });

    it("keeps raw commands for compaction and agent-skill restoration", () => {
      for (const metadata of [
        { type: "compaction-request", rawCommand: "/compact" },
        { type: "agent-skill", rawCommand: "/skill", skillName: "skill", scope: "built-in" },
      ]) {
        queue.add("expanded prompt", { ...options, muxMetadata: metadata });
        expect(queue.getVisibleRestoreText()).toBe(metadata.rawCommand);
        queue.clear();
      }
    });
  });

  describe("authoredAtMs", () => {
    it("returns the request-entry authoring time from dequeueNext when provided", () => {
      // Codex P2 (PRRT_kwDOPxxmWM6b-orA): the sender captures authoring time
      // before its preflight awaits (pricing gate, settings persistence);
      // sampling Date.now() at enqueue instead would postdate a goal that
      // became visible during those awaits and misclassify the message as an
      // intervention against a goal the user had not seen.
      const authoredAtMs = Date.now() - 5_000;
      queue.add("typed before preflight", undefined, { authoredAtMs });

      const { enqueuedAtMs } = queue.dequeueNext();
      expect(enqueuedAtMs).toBe(authoredAtMs);
    });

    it("keeps the newest authoring time when batched adds arrive out of authoring order", () => {
      // Codex security P2 (PRRT_kwDOPxxmWM6b_OS9): overlapping sends can
      // complete preflight out of authoring order. The batched entry must
      // report the NEWEST authoring time so a later post-goal stop/correction
      // is never masked by an older pre-goal message — otherwise the batch
      // would satisfy the pre-goal guard and keep the goal running despite
      // the user's intervention.
      const newerAuthoredAtMs = Date.now() - 1_000;
      const olderAuthoredAtMs = Date.now() - 10_000;
      queue.add("post-goal stop", undefined, { authoredAtMs: newerAuthoredAtMs });
      // The older send finishes its preflight late and batches into the entry.
      queue.add("pre-goal message", undefined, { authoredAtMs: olderAuthoredAtMs });

      const { enqueuedAtMs } = queue.dequeueNext();
      expect(enqueuedAtMs).toBe(newerAuthoredAtMs);
    });

    it("falls back to enqueue-time sampling when authoring time is absent", () => {
      const before = Date.now();
      queue.add("plain add");

      const { enqueuedAtMs } = queue.dequeueNext();
      expect(enqueuedAtMs).toBeGreaterThanOrEqual(before);
    });
  });

  describe("getDisplayText", () => {
    it("should return joined messages for normal messages", () => {
      queue.add("First message");
      queue.add("Second message");

      expect(queue.getDisplayText()).toBe("First message\nSecond message");
    });

    it("should hide synthetic background entries from the user-visible queue snapshot", () => {
      queue.add(
        "Background monitor wake",
        { model: "gpt-4", agentId: "exec", queueDispatchMode: "tool-end" },
        { synthetic: true, agentInitiated: true }
      );
      queue.add("User follow-up", {
        model: "gpt-4",
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });

      // Content projection hides backend work, while the visible card reflects the FIFO head's
      // effective boundary until the user explicitly reprioritizes their queued follow-up.
      expect(queue.getMessages()).toEqual(["Background monitor wake", "User follow-up"]);
      expect(queue.getVisibleMessages()).toEqual(["User follow-up"]);
      expect(queue.getVisibleDisplayText()).toBe("User follow-up");
      expect(queue.getQueueDispatchMode()).toBe("tool-end");
      expect(queue.getVisibleQueueDispatchMode()).toBe("tool-end");
      const background = queue.dequeueNext();
      expect(background.message).toBe("Background monitor wake");
      expect(background.internal).toMatchObject({ synthetic: true, agentInitiated: true });
      expect(queue.dequeueNext().message).toBe("User follow-up");
    });

    it("keeps agent peer messages sealed so later messages never coalesce with them", () => {
      const peerMetadata: MuxMessageMetadata = {
        type: "agent-peer-message",
        fromWorkspaceId: "task-sibling",
        fromTitle: "Watcher",
        relationship: "sibling",
      };
      queue.add(
        "<mux_agent_message>...</mux_agent_message>",
        { model: "gpt-4", agentId: "exec", muxMetadata: peerMetadata },
        // Matches the peer-send path: a removable dedupe key forces a sealed entry.
        { synthetic: true, agentInitiated: true, removableDedupeKey: true }
      );
      queue.add("User follow-up");

      // The follow-up starts a new entry: sender attribution stays on the peer entry alone,
      // and the count reflects exactly the queued peer messages.
      expect(queue.countAgentPeerMessageEntries()).toBe(1);
      expect(queue.getVisibleMessages()).toEqual(["User follow-up"]);

      const peerEntry = queue.dequeueNext();
      expect(peerEntry.message).toBe("<mux_agent_message>...</mux_agent_message>");
      expect(peerEntry.options?.muxMetadata).toEqual(peerMetadata);
      expect(queue.countAgentPeerMessageEntries()).toBe(0);
      expect(queue.dequeueNext().message).toBe("User follow-up");
    });

    it("threads the admission probe onto its own sealed entry and re-emits it at dispatch", () => {
      // A Stop landing after dequeue is invisible to queue clearing, so the probe must ride
      // the entry into the session's turn-admission gates — and it must not gate unrelated
      // batched messages.
      const admissionStale = () => true;
      queue.add("wake trigger", undefined, { synthetic: true, admissionStale });
      queue.add("User follow-up");

      const probeEntry = queue.dequeueNext();
      expect(probeEntry.message).toBe("wake trigger");
      expect(probeEntry.internal?.admissionStale).toBe(admissionStale);

      const followUp = queue.dequeueNext();
      expect(followUp.message).toBe("User follow-up");
      expect(followUp.internal?.admissionStale).toBeUndefined();
    });

    it("counts peer triggers by dedupe-key prefix when metadata carries a workspace-turn correlation", () => {
      // Upward sends into a delegated workspace turn replace the trigger's muxMetadata with the
      // turn correlation; the agent-msg: dedupe prefix must keep the peer count exact.
      queue.addOnce(
        "Peer agent task-sibling sent an agent message…",
        {
          model: "gpt-4",
          agentId: "exec",
          muxMetadata: {
            type: "workspace-turn-task",
            taskHandleId: "wt-1",
            ownerWorkspaceId: "owner-1",
            turnId: "turn-1",
          },
        },
        "agent-msg:task-sibling:uuid-1",
        { synthetic: true, agentInitiated: true, removableDedupeKey: true }
      );
      queue.add("User follow-up");

      expect(queue.countAgentPeerMessageEntries()).toBe(1);
      queue.dequeueNext();
      expect(queue.countAgentPeerMessageEntries()).toBe(0);
    });

    it("should return rawCommand for compaction request", () => {
      const metadata: MuxMessageMetadata = {
        type: "compaction-request",
        rawCommand: "/compact -t 3000",
        parsed: { maxOutputTokens: 3000 },
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      };

      queue.add("Summarize this conversation into a compact form...", options);

      expect(queue.getDisplayText()).toBe("/compact -t 3000");
    });

    it("should queue compaction after normal message as its own entry", () => {
      queue.add("First message");

      const metadata: MuxMessageMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      };

      // Compaction must not adopt earlier batched texts; it starts a new entry
      // and dispatches after the pending messages instead of erroring.
      expect(queue.add("Summarize this conversation...", options)).toBe(true);
      expect(queue.getDisplayText()).toBe("First message\n/compact");

      const first = queue.dequeueNext();
      expect(first.message).toBe("First message");
      expect(first.options?.muxMetadata).toBeUndefined();

      const second = queue.dequeueNext();
      expect(second.message).toBe("Summarize this conversation...");
      expect((second.options?.muxMetadata as MuxMessageMetadata).type).toBe("compaction-request");
      expect(queue.isEmpty()).toBe(true);
    });

    it("should return joined messages when metadata type is not compaction-request", () => {
      const metadata: MuxMessageMetadata = {
        type: "normal",
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      };

      queue.add("Regular message", options);

      expect(queue.getDisplayText()).toBe("Regular message");
    });

    it("should return empty string for empty queue", () => {
      expect(queue.getDisplayText()).toBe("");
    });

    it("should return joined messages after clearing compaction metadata", () => {
      const metadata: MuxMessageMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      };

      queue.add("Summarize this...", options);
      queue.clear();
      queue.add("New message");

      expect(queue.getDisplayText()).toBe("New message");
    });
  });

  describe("getMessages", () => {
    it("should return raw messages even for compaction requests", () => {
      const metadata: MuxMessageMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      };

      queue.add("Summarize this conversation...", options);

      // getMessages should return the actual message text for editing
      expect(queue.getMessages()).toEqual(["Summarize this conversation..."]);
      // getDisplayText should return the slash command
      expect(queue.getDisplayText()).toBe("/compact");
    });
  });

  describe("hasCompactionRequest", () => {
    it("should return false for empty queue", () => {
      expect(queue.hasCompactionRequest()).toBe(false);
    });

    it("should return false for normal messages", () => {
      queue.add("Regular message", { model: "gpt-4", agentId: "exec" });
      expect(queue.hasCompactionRequest()).toBe(false);
    });

    it("should return true when compaction request is queued", () => {
      const metadata: MuxMessageMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      queue.add("Summarize...", {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      });

      expect(queue.hasCompactionRequest()).toBe(true);
    });

    it("should return false after clearing", () => {
      const metadata: MuxMessageMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      queue.add("Summarize...", {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      });
      queue.clear();

      expect(queue.hasCompactionRequest()).toBe(false);
    });
  });

  describe("queue dispatch mode", () => {
    it("should default to tool-end when queueing without explicit mode", () => {
      queue.add("Follow up");

      expect(queue.getQueueDispatchMode()).toBe("tool-end");
    });

    it("should store explicit turn-end mode", () => {
      queue.add("Follow up", {
        model: "gpt-4",
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });

      expect(queue.getQueueDispatchMode()).toBe("turn-end");
    });

    it("should prioritize tool-end mode when mixed", () => {
      queue.add("Wait until turn ends", {
        model: "gpt-4",
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      queue.add("Interrupt at next tool step", {
        model: "gpt-4",
        agentId: "exec",
        queueDispatchMode: "tool-end",
      });

      expect(queue.getQueueDispatchMode()).toBe("tool-end");
    });

    it("should report tool-end when any pending entry wants tool-end", () => {
      const validOptions: SendMessageOptions = {
        model: "gpt-4",
        agentId: "exec",
      };

      queue.add("wait for turn end", {
        ...validOptions,
        queueDispatchMode: "turn-end",
      });
      expect(queue.getQueueDispatchMode()).toBe("turn-end");

      const metadata: MuxMessageMetadata = {
        type: "agent-skill",
        rawCommand: "/init",
        skillName: "init",
        scope: "built-in",
      };

      // A later entry queued for tool-end makes the whole queue drain at tool-end
      // (sticky, matching pre-entry batching semantics).
      queue.add("run skill", {
        ...validOptions,
        queueDispatchMode: "tool-end",
        muxMetadata: metadata,
      });
      expect(queue.getQueueDispatchMode()).toBe("tool-end");

      // Once the tool-end entry dispatches, the remaining entries' mode wins again.
      queue.dequeueNext(); // "wait for turn end" (FIFO head)
      expect(queue.getQueueDispatchMode()).toBe("tool-end");
      queue.dequeueNext(); // the tool-end skill entry
      expect(queue.getQueueDispatchMode()).toBe("tool-end"); // empty queue default
    });

    it("should keep per-entry modes so a turn-end tail does not downgrade the queue", () => {
      queue.add("interrupt soon", {
        model: "gpt-4",
        agentId: "exec",
        queueDispatchMode: "tool-end",
      });
      queue.add("later is fine", {
        model: "gpt-4",
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });

      expect(queue.getQueueDispatchMode()).toBe("tool-end");
    });

    it("updates and prioritizes all visible entries while preserving their relative order", () => {
      const validOptions: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
      queue.add(
        "hidden wake",
        { ...validOptions, queueDispatchMode: "tool-end" },
        {
          synthetic: true,
          agentInitiated: true,
          sealed: true,
        }
      );
      queue.add("visible first", { ...validOptions, queueDispatchMode: "tool-end" });
      queue.add("visible second", {
        ...validOptions,
        queueDispatchMode: "turn-end",
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/init",
          skillName: "init",
          scope: "built-in",
        },
      });

      expect(queue.setVisibleQueueDispatchMode("turn-end")).toBe(true);
      expect(queue.getVisibleQueueDispatchMode()).toBe("turn-end");
      expect(queue.getNextQueueDispatchMode()).toBe("turn-end");
      expect(queue.getQueueDispatchMode()).toBe("tool-end");
      expect(queue.getMessages()).toEqual(["visible first", "visible second", "hidden wake"]);

      queue.dequeueNext();
      expect(queue.getNextQueueDispatchMode()).toBe("turn-end");
    });

    it("reports a hidden predecessor's effective mode until the user reprioritizes the visible card", () => {
      const validOptions: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
      queue.add(
        "hidden predecessor",
        { ...validOptions, queueDispatchMode: "turn-end" },
        {
          synthetic: true,
          agentInitiated: true,
          sealed: true,
        }
      );
      queue.add("visible follow-up", { ...validOptions, queueDispatchMode: "tool-end" });

      expect(queue.getVisibleQueueDispatchMode()).toBe("turn-end");
      expect(queue.setVisibleQueueDispatchMode("tool-end")).toBe(true);
      expect(queue.getMessages()).toEqual(["visible follow-up", "hidden predecessor"]);
      expect(queue.getVisibleQueueDispatchMode()).toBe("tool-end");
      expect(queue.getNextQueueDispatchMode()).toBe("tool-end");
    });

    it("reports the first visible entry mode instead of a later visible tool-end entry", () => {
      const validOptions: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
      queue.add("visible turn-end head", {
        ...validOptions,
        queueDispatchMode: "turn-end",
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/init",
          skillName: "init",
          scope: "built-in",
        },
      });
      queue.add("visible tool-end tail", { ...validOptions, queueDispatchMode: "tool-end" });

      expect(queue.getVisibleQueueDispatchMode()).toBe("turn-end");
      queue.dequeueNext();
      expect(queue.getVisibleQueueDispatchMode()).toBe("tool-end");
    });

    it("uses the FIFO head mode for the next drain even when a later hidden entry is tool-end", () => {
      const validOptions: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
      queue.add("visible first", { ...validOptions, queueDispatchMode: "turn-end" });
      queue.add(
        "hidden later",
        { ...validOptions, queueDispatchMode: "tool-end" },
        {
          synthetic: true,
          agentInitiated: true,
          sealed: true,
        }
      );

      expect(queue.getQueueDispatchMode()).toBe("tool-end");
      expect(queue.getNextQueueDispatchMode()).toBe("turn-end");
      queue.dequeueNext();
      expect(queue.getNextQueueDispatchMode()).toBe("tool-end");
    });

    it("does not update a queue containing only hidden entries", () => {
      queue.add("hidden wake", undefined, { synthetic: true, agentInitiated: true });

      expect(queue.setVisibleQueueDispatchMode("turn-end")).toBe(false);
      expect(queue.getQueueDispatchMode()).toBe("tool-end");
    });

    it("skips withdrawn entries when reporting the next dispatchable mode", () => {
      const validOptions: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
      const withdrawn = new AbortController();
      queue.add(
        "withdrawn wake",
        { ...validOptions, queueDispatchMode: "tool-end" },
        { synthetic: true, agentInitiated: true, cancelSignal: withdrawn.signal }
      );
      expect(queue.getNextDispatchableMode()).toBe("tool-end");

      withdrawn.abort();
      expect(queue.getNextDispatchableMode()).toBeUndefined();
      expect(queue.isEmpty()).toBe(false);

      queue.add("follow up", { ...validOptions, queueDispatchMode: "turn-end" });
      expect(queue.getNextDispatchableMode()).toBe("turn-end");
      expect(queue.getNextQueueDispatchMode()).toBe("tool-end");
    });

    it("should reset mode to tool-end when cleared", () => {
      queue.add("Follow up", {
        model: "gpt-4",
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });

      queue.clear();

      expect(queue.getQueueDispatchMode()).toBe("tool-end");
    });
  });

  describe("promoteAheadOfHiddenTurnEnd", () => {
    const validOptions: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
    const hidden = { synthetic: true, agentInitiated: true, sealed: true };

    it("moves a tool-end progress report ahead of hidden turn-end predecessors so it cuts the turn", () => {
      queue.addOnce(
        "peer message",
        { ...validOptions, queueDispatchMode: "turn-end" },
        "agent-msg:child:1",
        hidden
      );
      expect(queue.getNextDispatchableMode()).toBe("turn-end");

      expect(
        queue.addOnce(
          "progress report",
          { ...validOptions, queueDispatchMode: "tool-end" },
          "agent-report:child:call-1",
          { ...hidden, removableDedupeKey: true, promoteAheadOfHiddenTurnEnd: true }
        )
      ).toBe(true);

      expect(queue.getNextDispatchableMode()).toBe("tool-end");
      expect(queue.getMessages()).toEqual(["progress report", "peer message"]);
      // The dedupe key follows the promoted entry, not the old tail.
      expect(queue.removeByDedupeKeyPrefix("agent-report:child:").removedCount).toBe(1);
      expect(queue.getMessages()).toEqual(["peer message"]);
    });

    it("never overtakes a user-authored turn-end entry", () => {
      queue.add("hidden turn-end", { ...validOptions, queueDispatchMode: "turn-end" }, hidden);
      queue.add("user wait for turn end", { ...validOptions, queueDispatchMode: "turn-end" });
      queue.add(
        "later hidden turn-end",
        { ...validOptions, queueDispatchMode: "turn-end" },
        hidden
      );

      queue.add(
        "progress report",
        { ...validOptions, queueDispatchMode: "tool-end" },
        { ...hidden, promoteAheadOfHiddenTurnEnd: true }
      );

      expect(queue.getMessages()).toEqual([
        "hidden turn-end",
        "user wait for turn end",
        "progress report",
        "later hidden turn-end",
      ]);
      expect(queue.getNextDispatchableMode()).toBe("turn-end");
    });

    it("keeps FIFO order behind an earlier tool-end entry and without the flag", () => {
      queue.add("hidden tool-end", { ...validOptions, queueDispatchMode: "tool-end" }, hidden);
      queue.add("hidden turn-end", { ...validOptions, queueDispatchMode: "turn-end" }, hidden);
      queue.add(
        "promoted",
        { ...validOptions, queueDispatchMode: "tool-end" },
        { ...hidden, promoteAheadOfHiddenTurnEnd: true }
      );
      queue.add("plain tool-end", { ...validOptions, queueDispatchMode: "tool-end" }, hidden);

      expect(queue.getMessages()).toEqual([
        "hidden tool-end",
        "promoted",
        "hidden turn-end",
        "plain tool-end",
      ]);
    });

    it("strips a skipped continuation's correlation, matching other reorders", () => {
      const onCanceled = () => undefined;
      queue.add(
        "continuation report",
        {
          ...validOptions,
          queueDispatchMode: "turn-end",
          muxMetadata: {
            type: "workspace-turn-task",
            taskHandleId: "wst_followup",
            ownerWorkspaceId: "parent-workspace",
            turnId: "turn-1",
          },
        },
        { ...hidden, workspaceTurnContinuation: true, onCanceled }
      );
      queue.add(
        "progress report",
        { ...validOptions, queueDispatchMode: "tool-end" },
        { ...hidden, promoteAheadOfHiddenTurnEnd: true }
      );

      expect(queue.dequeueNext().message).toBe("progress report");
      const skipped = queue.dequeueNext();
      expect(skipped.message).toBe("continuation report");
      expect(skipped.options?.muxMetadata).toBeUndefined();
      expect(skipped.internal?.onCanceled).toBeUndefined();
    });

    it("keeps same-turn correlation on skipped entries when the promoted report continues that turn", () => {
      // Parent runs as a delegated workspace turn: both the child's ancestor-bound peer message
      // and its later progress report continue the same turn. Promotion must revalidate with the
      // promoted entry's own metadata populated, or the peer message would be stripped and later
      // supersede the turn instead of continuing it.
      const turnMetadata: MuxMessageMetadata = {
        type: "workspace-turn-task",
        taskHandleId: "wst_parent",
        ownerWorkspaceId: "grandparent",
        turnId: "turn-1",
      };
      const peerCanceled = () => undefined;
      queue.add(
        "peer message",
        { ...validOptions, queueDispatchMode: "turn-end", muxMetadata: turnMetadata },
        { ...hidden, workspaceTurnContinuation: true, onCanceled: peerCanceled }
      );
      queue.add(
        "progress report",
        { ...validOptions, queueDispatchMode: "tool-end", muxMetadata: turnMetadata },
        { ...hidden, workspaceTurnContinuation: true, promoteAheadOfHiddenTurnEnd: true }
      );

      expect(queue.hasAllWorkspaceTurnContinuations("wst_parent", "grandparent", "turn-1")).toBe(
        true
      );
      const promoted = queue.dequeueNext();
      expect(promoted.message).toBe("progress report");
      expect(promoted.options?.muxMetadata).toEqual(turnMetadata);
      const skipped = queue.dequeueNext();
      expect(skipped.message).toBe("peer message");
      expect(skipped.options?.muxMetadata).toEqual(turnMetadata);
      expect(skipped.internal?.onCanceled).toBe(peerCanceled);
    });

    it("ignores the hidden turn-end entries a promoted report overtakes when judging its correlation", () => {
      // A queued heartbeat (hidden, turn-end, uncorrelated) would make the plain check report a
      // superseding predecessor and strip the report's correlation before enqueue — yet the
      // promoted report dispatches ahead of it, so it must keep continuing the delegated turn.
      const turnMetadata: MuxMessageMetadata = {
        type: "workspace-turn-task",
        taskHandleId: "wst_parent",
        ownerWorkspaceId: "grandparent",
        turnId: "turn-1",
      };
      const ahead = (): boolean =>
        queue.hasAllWorkspaceTurnContinuationsAheadOfPromotedToolEnd(
          "wst_parent",
          "grandparent",
          "turn-1"
        );

      expect(ahead()).toBe(true);
      queue.add(
        "same-turn follow-up",
        { ...validOptions, queueDispatchMode: "tool-end", muxMetadata: turnMetadata },
        hidden
      );
      expect(ahead()).toBe(true);

      queue.addOnce(
        "heartbeat",
        { ...validOptions, queueDispatchMode: "turn-end" },
        "heartbeat-request",
        hidden
      );
      expect(queue.hasAllWorkspaceTurnContinuations("wst_parent", "grandparent", "turn-1")).toBe(
        false
      );
      expect(ahead()).toBe(true);

      // An uncorrelated tool-end tail cannot be overtaken, so it (and everything before it) counts.
      queue.add("unrelated tool-end", { ...validOptions, queueDispatchMode: "tool-end" }, hidden);
      expect(ahead()).toBe(false);
    });

    it("counts a user-authored turn-end tail as a predecessor for a promoted report", () => {
      queue.add("user wait for turn end", { ...validOptions, queueDispatchMode: "turn-end" });
      expect(
        queue.hasAllWorkspaceTurnContinuationsAheadOfPromotedToolEnd(
          "wst_parent",
          "grandparent",
          "turn-1"
        )
      ).toBe(false);
    });
  });

  describe("workspace turn metadata", () => {
    const metadata: MuxMessageMetadata = {
      type: "workspace-turn-task",
      taskHandleId: "wst_followup",
      ownerWorkspaceId: "parent-workspace",
      turnId: "turn-1",
    };

    it("should queue user messages behind a workspace-turn follow-up instead of erroring", () => {
      // Regression: sending a message while an internal workspace-turn follow-up
      // was queued used to fail with "Cannot queue additional messages".
      const onAccepted = () => undefined;
      queue.add(
        "Follow up",
        { model: "gpt-4", agentId: "exec", muxMetadata: metadata },
        { agentInitiated: true, onAccepted }
      );

      expect(queue.add("Second message")).toBe(true);
      expect(queue.getMessages()).toEqual(["Follow up", "Second message"]);

      // FIFO: the workspace turn dispatches first with its metadata + callbacks...
      const first = queue.dequeueNext();
      expect(first.message).toBe("Follow up");
      expect((first.options?.muxMetadata as MuxMessageMetadata).type).toBe("workspace-turn-task");
      expect(first.internal?.onAccepted).toBe(onAccepted);

      // ...and the user message dispatches after it, without adopting either.
      const second = queue.dequeueNext();
      expect(second.message).toBe("Second message");
      expect(second.options?.muxMetadata).toBeUndefined();
      expect(second.internal).toBeUndefined();
      expect(queue.isEmpty()).toBe(true);
    });

    it("should queue a workspace-turn follow-up behind pending messages", () => {
      queue.add("Normal message");
      expect(
        queue.add("Follow up", { model: "gpt-4", agentId: "exec", muxMetadata: metadata })
      ).toBe(true);
      expect(queue.hasWorkspaceTurn("wst_followup")).toBe(true);

      const first = queue.dequeueNext();
      expect(first.message).toBe("Normal message");
      expect(first.options?.muxMetadata).toBeUndefined();
      expect(queue.hasWorkspaceTurn("wst_followup")).toBe(true);

      const second = queue.dequeueNext();
      expect((second.options?.muxMetadata as MuxMessageMetadata).type).toBe("workspace-turn-task");
      expect(queue.hasWorkspaceTurn("wst_followup")).toBe(false);
    });

    it("should detect only the next entry with the exact workspace-turn correlation", () => {
      queue.add("Normal message");
      queue.add("Follow up", { model: "gpt-4", agentId: "exec", muxMetadata: metadata });

      expect(
        queue.hasNextWorkspaceTurnContinuation("wst_followup", "parent-workspace", "turn-1")
      ).toBe(false);

      queue.dequeueNext();
      expect(
        queue.hasNextWorkspaceTurnContinuation("wst_followup", "parent-workspace", "turn-1")
      ).toBe(true);
      expect(
        queue.hasNextWorkspaceTurnContinuation("wst_other", "parent-workspace", "turn-1")
      ).toBe(false);
    });

    it("should reject a same-turn continuation when any queued predecessor is unrelated", () => {
      queue.add("First follow up", { model: "gpt-4", agentId: "exec", muxMetadata: metadata });
      queue.add("Second follow up", { model: "gpt-4", agentId: "exec", muxMetadata: metadata });

      expect(
        queue.hasAllWorkspaceTurnContinuations("wst_followup", "parent-workspace", "turn-1")
      ).toBe(true);

      queue.add("Unrelated message");

      expect(
        queue.hasAllWorkspaceTurnContinuations("wst_followup", "parent-workspace", "turn-1")
      ).toBe(false);
    });

    it("exposes the head entry's metadata and dispatch mode as the queue-cut candidate", () => {
      expect(queue.getNextQueueCutCandidate()).toBeUndefined();

      queue.add("Follow up", {
        model: "gpt-4",
        agentId: "exec",
        muxMetadata: metadata,
        queueDispatchMode: "turn-end",
      });

      const candidate = queue.getNextQueueCutCandidate();
      expect(candidate?.dispatchMode).toBe("turn-end");
      expect((candidate?.muxMetadata as MuxMessageMetadata).type).toBe("workspace-turn-task");
    });

    it("never batches a user message into a sealed workspace-turn entry", () => {
      // Cut attribution reads the head entry's muxMetadata; the sealing
      // invariant guarantees a manual user message queued after a
      // workspace-turn follow-up lands in a SEPARATE entry, so workspace-turn
      // metadata can never mask user-authored text.
      queue.add("Follow up", { model: "gpt-4", agentId: "exec", muxMetadata: metadata });
      queue.add("Manual user message");

      expect(queue.getMessages()).toEqual(["Follow up", "Manual user message"]);
      expect((queue.getNextQueueCutCandidate()?.muxMetadata as MuxMessageMetadata).type).toBe(
        "workspace-turn-task"
      );

      queue.dequeueNext();
      const next = queue.getNextQueueCutCandidate();
      expect(next).toBeDefined();
      expect(next?.muxMetadata).toBeUndefined();
    });

    it("should strip correlation when queue reordering moves user input ahead", () => {
      const onCanceled = () => undefined;
      const onAcceptedPreStreamFailure = () => undefined;
      queue.add(
        "Background report",
        { model: "gpt-4", agentId: "exec", muxMetadata: metadata },
        {
          synthetic: true,
          agentInitiated: true,
          workspaceTurnContinuation: true,
          onCanceled,
          onAcceptedPreStreamFailure,
        }
      );
      queue.add("User send now", { model: "gpt-4", agentId: "exec" });

      expect(queue.setVisibleQueueDispatchMode("tool-end")).toBe(true);

      const first = queue.dequeueNext();
      expect(first.message).toBe("User send now");

      const second = queue.dequeueNext();
      expect(second.message).toBe("Background report");
      expect(second.options?.muxMetadata).toBeUndefined();
      expect(second.internal?.onCanceled).toBeUndefined();
      expect(second.internal?.onAcceptedPreStreamFailure).toBeUndefined();
    });

    it("should keep peer trigger identity and refund hook when correlation is stripped", () => {
      const onCanceled = () => undefined;
      const onAcceptedPreStreamFailure = () => undefined;
      queue.add(
        "Peer trigger",
        {
          model: "gpt-4",
          agentId: "exec",
          muxMetadata: {
            ...metadata,
            agentPeerMessageTrigger: { fromWorkspaceId: "sib-a", relationship: "sibling" },
          },
        },
        {
          synthetic: true,
          agentInitiated: true,
          workspaceTurnContinuation: true,
          onCanceled,
          onAcceptedPreStreamFailure,
        }
      );
      queue.add("User send now", { model: "gpt-4", agentId: "exec" });

      expect(queue.setVisibleQueueDispatchMode("tool-end")).toBe(true);

      const first = queue.dequeueNext();
      expect(first.message).toBe("User send now");

      // The superseded correlation is stripped, but a peer trigger keeps its
      // machine-notification identity (downgraded to plain peer attribution) plus both refund
      // hooks — onCanceled and onAcceptedPreStreamFailure carry the sender's budget refund,
      // tied to this entry rather than the superseded owner handle.
      const second = queue.dequeueNext();
      expect(second.options?.muxMetadata).toEqual({
        type: "agent-peer-message",
        fromWorkspaceId: "sib-a",
        relationship: "sibling",
      });
      expect(second.internal?.onCanceled).toBe(onCanceled);
      expect(second.internal?.onAcceptedPreStreamFailure).toBe(onAcceptedPreStreamFailure);
    });

    it("should preserve an original queued workspace-turn prompt during reordering", () => {
      const onAccepted = () => undefined;
      const onCanceled = () => undefined;
      queue.add(
        "Original workspace-turn prompt",
        { model: "gpt-4", agentId: "exec", muxMetadata: metadata },
        { agentInitiated: true, onAccepted, onCanceled }
      );
      queue.add("User send now", { model: "gpt-4", agentId: "exec" });

      expect(queue.setVisibleQueueDispatchMode("tool-end")).toBe(true);

      const first = queue.dequeueNext();
      expect(first.message).toBe("User send now");

      const second = queue.dequeueNext();
      expect(second.message).toBe("Original workspace-turn prompt");
      expect(second.options?.muxMetadata).toEqual(metadata);
      expect(second.internal?.onAccepted).toBe(onAccepted);
      expect(second.internal?.onCanceled).toBe(onCanceled);
    });

    it("should preserve internal workspace-turn callbacks", () => {
      const onAccepted = () => undefined;
      const onAcceptedPreStreamFailure = () => undefined;
      const onCanceled = () => undefined;

      queue.add(
        "Follow up",
        { model: "gpt-4", agentId: "exec", muxMetadata: metadata },
        { agentInitiated: true, onAccepted, onAcceptedPreStreamFailure, onCanceled }
      );

      const clearCallbacks = queue.getClearCallbacks();
      expect(clearCallbacks).toHaveLength(1);
      expect(clearCallbacks[0].onCanceled).toBe(onCanceled);

      const { internal } = queue.dequeueNext();
      expect(internal?.agentInitiated).toBe(true);
      expect(internal?.onAccepted).toBe(onAccepted);
      expect(internal?.onAcceptedPreStreamFailure).toBe(onAcceptedPreStreamFailure);
      expect(internal?.onCanceled).toBe(onCanceled);
    });

    it("removeWorkspaceTurn drops only the matching entry and keeps user messages", () => {
      const onCanceled = () => undefined;
      queue.add("User message before");
      queue.add(
        "Follow up",
        { model: "gpt-4", agentId: "exec", muxMetadata: metadata },
        { agentInitiated: true, onCanceled }
      );
      queue.add("User message after");

      expect(queue.removeWorkspaceTurn("wst_other")).toBeNull();

      const callbacks = queue.removeWorkspaceTurn("wst_followup");
      expect(callbacks?.onCanceled).toBe(onCanceled);
      expect(queue.hasWorkspaceTurn("wst_followup")).toBe(false);
      // Unrelated queued input survives the targeted cancel.
      expect(queue.getMessages()).toEqual(["User message before", "User message after"]);
    });

    it("should report clear callbacks for every pending entry", () => {
      const onCanceledFirst = () => undefined;
      const onCanceledSecond = () => undefined;

      queue.add(
        "First follow up",
        { model: "gpt-4", agentId: "exec" },
        {
          onCanceled: onCanceledFirst,
        }
      );
      queue.add("User message in between");
      queue.add(
        "Second follow up",
        { model: "gpt-4", agentId: "exec" },
        {
          onCanceled: onCanceledSecond,
        }
      );

      const clearCallbacks = queue.getClearCallbacks();
      expect(clearCallbacks.map((callbacks) => callbacks.onCanceled)).toEqual([
        onCanceledFirst,
        onCanceledSecond,
      ]);
    });
  });

  describe("goal intervention policy", () => {
    it("should preserve steering policy for queued user messages", () => {
      queue.add("Steer next turn", {
        model: "gpt-4",
        agentId: "exec",
        goalInterventionPolicy: "steer",
      });

      const { options } = queue.dequeueNext();

      expect(options?.goalInterventionPolicy).toBe("steer");
    });

    it("should keep explicit pause sticky when mixed with steering", () => {
      queue.add("Pause this goal", {
        model: "gpt-4",
        agentId: "exec",
        goalInterventionPolicy: "pause",
      });
      queue.add("Also steer", {
        model: "gpt-4",
        agentId: "exec",
        goalInterventionPolicy: "steer",
      });

      const { options } = queue.dequeueNext();

      expect(options?.goalInterventionPolicy).toBe("pause");
    });

    it("should reset goal intervention policy when cleared", () => {
      queue.add("Pause this goal", {
        model: "gpt-4",
        agentId: "exec",
        goalInterventionPolicy: "pause",
      });

      queue.clear();
      queue.add("Plain follow-up", { model: "gpt-4", agentId: "exec" });

      const { options } = queue.dequeueNext();
      expect(options?.goalInterventionPolicy).toBeUndefined();
    });
  });

  describe("addOnce", () => {
    it("should dedupe repeated entries by key", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      const addedFirst = queue.addOnce(
        "Follow up",
        { model: "gpt-4", agentId: "exec", fileParts: [image] },
        "follow-up"
      );
      const addedSecond = queue.addOnce(
        "Follow up",
        { model: "gpt-4", agentId: "exec", fileParts: [image] },
        "follow-up"
      );

      expect(addedFirst).toBe(true);
      expect(addedSecond).toBe(false);
      expect(queue.getMessages()).toEqual(["Follow up"]);
      expect(queue.getFileParts()).toEqual([image]);
    });

    it("keeps ordinary addOnce batching semantics for non-removable dedupe keys", () => {
      const queue = new MessageQueue();
      queue.add("User follow-up");
      queue.addOnce("Heartbeat", undefined, "heartbeat-request");

      expect(queue.getMessages()).toEqual(["User follow-up", "Heartbeat"]);
    });

    it("removes entries by dedupe key prefix while preserving unrelated messages", () => {
      const queue = new MessageQueue();
      queue.addOnce("child one", undefined, "agent-report:child-one:update", {
        synthetic: true,
        removableDedupeKey: true,
      });
      queue.addOnce("child two", undefined, "agent-report:child-two:update", {
        synthetic: true,
        removableDedupeKey: true,
      });
      queue.add("other synthetic", undefined, { synthetic: true });

      expect(queue.removeByDedupeKeyPrefix("agent-report:child-one:")).toEqual({
        removedCount: 1,
        callbacks: [],
      });
      expect(queue.hasDedupeKey("agent-report:child-one:update")).toBe(false);
      expect(queue.hasDedupeKey("agent-report:child-two:update")).toBe(true);
      expect(queue.dequeueNext().message).toBe("child two");
      expect(queue.dequeueNext().message).toBe("other synthetic");
    });

    it("should report pending dedupe keys and reset them when the queue clears", () => {
      expect(queue.hasDedupeKey("heartbeat-request")).toBe(false);

      queue.addOnce("Heartbeat", { model: "gpt-4", agentId: "exec" }, "heartbeat-request");
      expect(queue.hasDedupeKey("heartbeat-request")).toBe(true);

      // Drain and user-clear both go through clear(), which must release the key so the
      // next scheduled message can enqueue again.
      queue.clear();
      expect(queue.hasDedupeKey("heartbeat-request")).toBe(false);
      expect(
        queue.addOnce("Heartbeat", { model: "gpt-4", agentId: "exec" }, "heartbeat-request")
      ).toBe(true);
    });

    it("holdsOnlyDedupeKey is true only when the keyed entry is the sole queue content", () => {
      // Empty queue: nothing to supersede.
      expect(queue.holdsOnlyDedupeKey("heartbeat-request")).toBe(false);

      // Sole keyed entry: droppable so later real input never batches behind it.
      queue.addOnce("Heartbeat", { model: "gpt-4", agentId: "exec" }, "heartbeat-request");
      expect(queue.holdsOnlyDedupeKey("heartbeat-request")).toBe(true);

      // Once anything else shares the queue, a blanket drop would destroy real input.
      queue.add("User follow-up", { model: "gpt-4", agentId: "exec" });
      expect(queue.holdsOnlyDedupeKey("heartbeat-request")).toBe(false);
    });

    it("should dedupe a keyed entry queued behind an existing plain message", () => {
      queue.add("User follow-up", { model: "gpt-4", agentId: "exec" });

      expect(
        queue.addOnce("Heartbeat", { model: "gpt-4", agentId: "exec" }, "heartbeat-request")
      ).toBe(true);
      expect(
        queue.addOnce("Heartbeat", { model: "gpt-4", agentId: "exec" }, "heartbeat-request")
      ).toBe(false);
      expect(queue.getMessages()).toEqual(["User follow-up", "Heartbeat"]);
    });

    it("prioritizeNextUserEntry moves user input ahead of hidden background work", () => {
      queue.add("Background wake", { model: "gpt-4", agentId: "exec" }, { synthetic: true });
      queue.add("User send now", { model: "gpt-4", agentId: "exec" });
      queue.add(
        "Later background wake",
        { model: "gpt-4", agentId: "exec" },
        {
          synthetic: true,
        }
      );

      expect(queue.prioritizeNextUserEntry()).toBe(true);
      expect(queue.dequeueNext().message).toBe("User send now");
      expect(queue.dequeueNext().message).toBe("Background wake");
      expect(queue.dequeueNext().message).toBe("Later background wake");
      expect(queue.prioritizeNextUserEntry()).toBe(false);
    });

    it("should release a dedupe key when its entry dispatches", () => {
      queue.addOnce("Heartbeat", { model: "gpt-4", agentId: "exec" }, "heartbeat-request");
      expect(queue.hasDedupeKey("heartbeat-request")).toBe(true);

      queue.dequeueNext();

      // The key belongs to the dispatched entry, so the next scheduled message
      // can enqueue again even if other entries were still pending.
      expect(queue.hasDedupeKey("heartbeat-request")).toBe(false);
      expect(
        queue.addOnce("Heartbeat", { model: "gpt-4", agentId: "exec" }, "heartbeat-request")
      ).toBe(true);
    });
  });

  describe("multi-message batching", () => {
    it("should batch multiple follow-up messages", () => {
      queue.add("First message");
      queue.add("Second message");
      queue.add("Third message");

      expect(queue.getMessages()).toEqual(["First message", "Second message", "Third message"]);
      expect(queue.getDisplayText()).toBe("First message\nSecond message\nThird message");
    });

    it("should preserve compaction metadata when follow-up is added", () => {
      const metadata: MuxMessageMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      queue.add("Summarize...", {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      });
      queue.add("And then do this follow-up task");

      // Display shows all messages (multiple messages = not just compaction)
      expect(queue.getDisplayText()).toBe("Summarize...\nAnd then do this follow-up task");

      // getMessages includes both
      expect(queue.getMessages()).toEqual(["Summarize...", "And then do this follow-up task"]);

      // dequeueNext preserves compaction metadata from the entry's first message
      const { message, options } = queue.dequeueNext();
      expect(message).toBe("Summarize...\nAnd then do this follow-up task");
      const muxMeta = options?.muxMetadata as MuxMessageMetadata;
      expect(muxMeta.type).toBe("compaction-request");
      if (muxMeta.type === "compaction-request") {
        expect(muxMeta.rawCommand).toBe("/compact");
      }
    });

    it("should queue an agent-skill invocation after a normal message as its own entry", () => {
      queue.add("First message");

      const metadata: MuxMessageMetadata = {
        type: "agent-skill",
        rawCommand: "/init",
        skillName: "init",
        scope: "built-in",
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      };

      // Skill metadata must not adopt earlier batched texts; the invocation
      // dispatches after the pending messages instead of erroring.
      expect(queue.add("Using skill init", options)).toBe(true);
      expect(queue.getDisplayText()).toBe("First message\n/init");

      const first = queue.dequeueNext();
      expect(first.message).toBe("First message");
      expect(first.options?.muxMetadata).toBeUndefined();

      const second = queue.dequeueNext();
      expect((second.options?.muxMetadata as MuxMessageMetadata).type).toBe("agent-skill");
    });

    it("should queue an MCP prompt invocation after a normal message as its own entry", () => {
      queue.add("First message");

      const metadata: MuxMessageMetadata = {
        type: "normal",
        rawCommand: "/mcp__coder__review src",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
            arguments: { path: "src" },
          },
        ],
      };

      // Batching keeps only an entry's first muxMetadata, which would drop the
      // prompt refs and skip snapshot materialization at dispatch.
      expect(
        queue.add("Using MCP prompt coder/review: src", {
          model: "claude-3-5-sonnet-20241022",
          agentId: "exec",
          muxMetadata: metadata,
        })
      ).toBe(true);

      const first = queue.dequeueNext();
      expect(first.message).toBe("First message");
      expect(first.options?.muxMetadata).toBeUndefined();

      const second = queue.dequeueNext();
      expect((second.options?.muxMetadata as MuxMessageMetadata).mcpPromptRefs).toHaveLength(1);
    });

    it("should queue an inline skill reference after a normal message as its own entry", () => {
      queue.add("First message");

      const metadata: MuxMessageMetadata = {
        type: "normal",
        agentSkillRefs: [{ skillName: "tdd", scope: "global", source: "inline" }],
      };

      expect(
        queue.add("Apply $tdd here", {
          model: "claude-3-5-sonnet-20241022",
          agentId: "exec",
          muxMetadata: metadata,
        })
      ).toBe(true);

      const first = queue.dequeueNext();
      expect(first.options?.muxMetadata).toBeUndefined();

      const second = queue.dequeueNext();
      expect((second.options?.muxMetadata as MuxMessageMetadata).agentSkillRefs).toHaveLength(1);
    });

    it("should queue a normal message behind an agent-skill invocation without leaking metadata", () => {
      const metadata: MuxMessageMetadata = {
        type: "agent-skill",
        rawCommand: "/init",
        skillName: "init",
        scope: "built-in",
      };

      queue.add("Use skill init", {
        model: "claude-3-5-sonnet-20241022",
        agentId: "exec",
        muxMetadata: metadata,
      });

      expect(queue.getDisplayText()).toBe("/init");

      // Skill entries are sealed: the follow-up starts a new entry and dispatches
      // after the skill turn instead of adopting its metadata (or erroring).
      expect(queue.add("Follow-up message")).toBe(true);
      expect(queue.getDisplayText()).toBe("/init\nFollow-up message");

      const first = queue.dequeueNext();
      expect(first.message).toBe("Use skill init");
      expect((first.options?.muxMetadata as MuxMessageMetadata).type).toBe("agent-skill");

      const second = queue.dequeueNext();
      expect(second.message).toBe("Follow-up message");
      expect(second.options?.muxMetadata).toBeUndefined();
    });

    it("should produce combined message for API call", () => {
      queue.add("First message", { model: "gpt-4", agentId: "exec" });
      queue.add("Second message");

      const { message, options } = queue.dequeueNext();

      // Messages are joined with newlines
      expect(message).toBe("First message\nSecond message");
      // Latest options are used
      expect(options?.model).toBe("gpt-4");
    });

    it("should batch messages with mixed images", () => {
      const image1 = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      const image2 = { url: "data:image/jpeg;base64,def", mediaType: "image/jpeg" };

      queue.add("Message with image", {
        model: "gpt-4",
        agentId: "exec",
        fileParts: [image1],
      });
      queue.add("Follow-up without image");
      queue.add("Another with image", {
        model: "gpt-4",
        agentId: "exec",
        fileParts: [image2],
      });

      expect(queue.getMessages()).toEqual([
        "Message with image",
        "Follow-up without image",
        "Another with image",
      ]);
      expect(queue.getFileParts()).toEqual([image1, image2]);
      expect(queue.getDisplayText()).toBe(
        "Message with image\nFollow-up without image\nAnother with image"
      );
    });
  });

  describe("internal flags", () => {
    it("should preserve synthetic flag for queued backend messages", () => {
      queue.add(
        "Background maintenance message",
        { model: "gpt-4", agentId: "exec" },
        { synthetic: true }
      );

      const { internal } = queue.dequeueNext();
      expect(internal).toEqual({ synthetic: true });
    });

    it("should keep synthetic and user messages in separate entries", () => {
      queue.add("Idle compaction", { model: "gpt-4", agentId: "compact" }, { synthetic: true });
      queue.add("User follow-up", { model: "gpt-4", agentId: "exec" });

      const background = queue.dequeueNext();
      expect(background.message).toBe("Idle compaction");
      expect(background.internal).toEqual({ synthetic: true });

      const user = queue.dequeueNext();
      expect(user.message).toBe("User follow-up");
      expect(user.internal).toBeUndefined();
    });

    it("should clear synthetic flag when queue is cleared", () => {
      queue.add("Synthetic one", { model: "gpt-4", agentId: "exec" }, { synthetic: true });
      queue.clear();

      queue.add("User message", { model: "gpt-4", agentId: "exec" });
      const { internal } = queue.dequeueNext();
      expect(internal).toBeUndefined();
    });
  });

  describe("getFileParts", () => {
    it("should return accumulated images from multiple messages", () => {
      const image1 = {
        url: "data:image/png;base64,abc",
        mediaType: "image/png",
      };
      const image2 = {
        url: "data:image/jpeg;base64,def",
        mediaType: "image/jpeg",
      };
      const image3 = {
        url: "data:image/gif;base64,ghi",
        mediaType: "image/gif",
      };

      queue.add("First message", {
        model: "gpt-4",
        agentId: "exec",
        fileParts: [image1],
      });
      queue.add("Second message", {
        model: "gpt-4",
        agentId: "exec",
        fileParts: [image2, image3],
      });

      const images = queue.getFileParts();
      expect(images).toEqual([image1, image2, image3]);
    });

    it("should return empty array when no images", () => {
      queue.add("Text only message");
      expect(queue.getFileParts()).toEqual([]);
    });

    it("should return copy of images array", () => {
      const image = {
        type: "file" as const,
        url: "data:image/png;base64,abc",
        mediaType: "image/png",
      };
      queue.add("Message", { model: "gpt-4", agentId: "exec", fileParts: [image] });

      const images1 = queue.getFileParts();
      const images2 = queue.getFileParts();

      expect(images1).toEqual(images2);
      expect(images1).not.toBe(images2); // Different array instances
    });

    it("should clear images when queue is cleared", () => {
      const image = {
        url: "data:image/png;base64,abc",
        mediaType: "image/png",
      };
      queue.add("Message", { model: "gpt-4", agentId: "exec", fileParts: [image] });

      expect(queue.getFileParts()).toHaveLength(1);

      queue.clear();
      expect(queue.getFileParts()).toEqual([]);
    });
  });

  describe("image-only messages", () => {
    it("should accept image-only messages (empty text with images)", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", agentId: "exec", fileParts: [image] });

      expect(queue.getMessages()).toEqual([]);
      expect(queue.getFileParts()).toEqual([image]);
      expect(queue.isEmpty()).toBe(false);
    });

    it("should reject messages with empty text and no images", () => {
      queue.add("", { model: "gpt-4", agentId: "exec" });

      expect(queue.isEmpty()).toBe(true);
      expect(queue.getMessages()).toEqual([]);
      expect(queue.getFileParts()).toEqual([]);
    });

    it("should handle mixed text and image-only messages", () => {
      const image1 = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      const image2 = { url: "data:image/jpeg;base64,def", mediaType: "image/jpeg" };

      queue.add("Text message", { model: "gpt-4", agentId: "exec", fileParts: [image1] });
      queue.add("", { model: "gpt-4", agentId: "exec", fileParts: [image2] }); // Image-only

      expect(queue.getMessages()).toEqual(["Text message"]);
      expect(queue.getFileParts()).toEqual([image1, image2]);
      expect(queue.isEmpty()).toBe(false);
    });

    it("should consider queue non-empty when only images present", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", agentId: "exec", fileParts: [image] });

      expect(queue.isEmpty()).toBe(false);
    });

    it("should produce correct message for image-only queue", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", agentId: "exec", fileParts: [image] });

      const { message, options } = queue.dequeueNext();

      expect(message).toBe("");
      expect(options?.fileParts).toEqual([image]);
      expect(options?.model).toBe("gpt-4");
    });

    it("should return empty string for getDisplayText with image-only", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", agentId: "exec", fileParts: [image] });

      expect(queue.getDisplayText()).toBe("");
    });
  });

  describe("preTurnMessages", () => {
    const preTurnRow = (id: string) =>
      createMuxMessage(id, "assistant", `payload ${id}`, { timestamp: 0, synthetic: true });

    it("seals entries carrying pre-turn rows and returns them from dequeueNext", () => {
      // r30: a family trigger and its payload row must stay 1:1 — a later
      // synthetic message batching into the same entry would join the trigger
      // texts while both payloads pile onto one dispatch.
      queue.add(
        "trigger one",
        { model: "gpt-4", agentId: "exec", queueDispatchMode: "tool-end" },
        { synthetic: true, agentInitiated: true, preTurnMessages: [preTurnRow("fam-1")] }
      );
      queue.add(
        "trigger two",
        { model: "gpt-4", agentId: "exec", queueDispatchMode: "tool-end" },
        { synthetic: true, agentInitiated: true, preTurnMessages: [preTurnRow("fam-2")] }
      );

      const first = queue.dequeueNext();
      expect(first.message).toBe("trigger one");
      expect(first.internal?.preTurnMessages?.map((row) => row.id)).toEqual(["fam-1"]);

      const second = queue.dequeueNext();
      expect(second.message).toBe("trigger two");
      expect(second.internal?.preTurnMessages?.map((row) => row.id)).toEqual(["fam-2"]);
      expect(queue.isEmpty()).toBe(true);
    });

    it("keeps later plain synthetic messages out of a pre-turn entry", () => {
      queue.add(
        "trigger",
        { model: "gpt-4", agentId: "exec", queueDispatchMode: "tool-end" },
        { synthetic: true, agentInitiated: true, preTurnMessages: [preTurnRow("fam-3")] }
      );
      queue.add(
        "unrelated background wake",
        { model: "gpt-4", agentId: "exec", queueDispatchMode: "tool-end" },
        { synthetic: true, agentInitiated: true }
      );

      const first = queue.dequeueNext();
      expect(first.message).toBe("trigger");
      expect(first.internal?.preTurnMessages?.map((row) => row.id)).toEqual(["fam-3"]);

      const second = queue.dequeueNext();
      expect(second.message).toBe("unrelated background wake");
      expect(second.internal?.preTurnMessages).toBeUndefined();
    });
  });
});
