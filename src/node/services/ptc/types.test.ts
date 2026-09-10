import { describe, expect, it } from "bun:test";
import { parsePatch } from "diff";
import { AgentSkillPackageSchema } from "@/common/orpc/schemas/agentSkill";
import { MAX_FILE_CONTENT_SIZE } from "@/common/constants/attachments";
import {
  KERNEL_RETAINED_CONTAINER_MAX_PARTS,
  KERNEL_RETAINED_MEDIA_BUDGET_BYTES,
} from "@/constants/kernelOutput";
import {
  createCaptureSanitizerBudget,
  retainExemptKernelRecordResult,
  retainPersistenceCriticalArgsFields,
  retainWorkflowResultIdentityFields,
  sanitizeCapturedMediaValue,
  sanitizeMediaRecordCapture,
  SANITIZER_BUDGET_EXHAUSTED_STUB,
} from "./types";

interface RetainedContainer {
  type?: string;
  value: Array<{ type?: string; text?: string; data?: string }>;
}

describe("retainExemptKernelRecordResult", () => {
  describe("agent_skill_read", () => {
    const oversizedSkill = {
      scope: "project",
      directoryName: "demo",
      frontmatter: { name: "demo", description: "a demo skill" },
      body: "B".repeat(MAX_FILE_CONTENT_SIZE),
    };

    it("truncates an oversized skill body into a schema-valid bounded package", () => {
      // A valid skill near the 50k snapshot limit serializes above the
      // retained-record cap once frontmatter overhead is added; discarding it
      // would erase the skill instructions from every later turn — the body
      // must degrade like createLoadedSkillSnapshot's own truncation.
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: oversizedSkill,
      }) as { success?: boolean; skill?: { body?: string } };
      expect(retained?.success).toBe(true);
      expect(retained?.skill?.body?.startsWith("BBB")).toBe(true);
      expect(
        retained?.skill?.body?.endsWith(
          "[Skill body truncated at capture to fit the retained-record cap]"
        )
      ).toBe(true);
      expect(JSON.stringify(retained).length).toBeLessThanOrEqual(MAX_FILE_CONTENT_SIZE);
      // The snapshot extractor's schema still accepts the bounded package.
      expect(AgentSkillPackageSchema.safeParse(retained?.skill).success).toBe(true);
    });

    it("falls back to normal bounding for malformed oversized packages", () => {
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: "not-an-object".repeat(10_000),
      });
      expect(retained).toBeUndefined();
    });

    it("keeps emoji-leading bodies when the budget is below a lone-surrogate escape", () => {
      // Serialized length is NOT monotonic in code units across a surrogate
      // pair: a code-unit midpoint inside a leading emoji serializes to a
      // 6-char \udXXX escape and would reject a budget the whole 2-char pair
      // fits, losing the package entirely — the search must test complete
      // code points (r22). Budget is pinned to 3 chars via a pad field the
      // schema strips.
      const note = "\n\n[Skill body truncated at capture to fit the retained-record cap]";
      const noteChars = JSON.stringify(note).length - 2;
      const emptyBodySkill = { ...oversizedSkill, body: "", pad: "" };
      const overheadEmpty = JSON.stringify({ success: true, skill: emptyBodySkill }).length;
      const pad = "p".repeat(MAX_FILE_CONTENT_SIZE - overheadEmpty - noteChars - 3);
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: { ...oversizedSkill, body: "🎉".repeat(60), pad },
      }) as { success?: boolean; skill?: { body?: string } };
      expect(retained?.success).toBe(true);
      // Exactly one whole emoji fits the 3-char budget (2 serialized chars).
      expect(retained?.skill?.body?.startsWith("🎉")).toBe(true);
      expect(retained?.skill?.body?.startsWith("🎉🎉")).toBe(false);
      expect(retained?.skill?.body?.endsWith(note)).toBe(true);
      expect(JSON.stringify(retained).length).toBeLessThanOrEqual(MAX_FILE_CONTENT_SIZE);
      expect(AgentSkillPackageSchema.safeParse(retained?.skill).success).toBe(true);
    });

    it("retains the package when the body budget is exactly zero", () => {
      // overhead + note == MAX_FILE_CONTENT_SIZE exactly: the empty prefix +
      // note fits the cap exactly, so zero is a valid budget — only negative
      // budgets (overhead + note alone exceed the cap) are unretainable (r24).
      const note = "\n\n[Skill body truncated at capture to fit the retained-record cap]";
      const noteChars = JSON.stringify(note).length - 2;
      const emptyBodySkill = { ...oversizedSkill, body: "", pad: "" };
      const overheadEmpty = JSON.stringify({ success: true, skill: emptyBodySkill }).length;
      const zeroPad = "p".repeat(MAX_FILE_CONTENT_SIZE - overheadEmpty - noteChars);
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: { ...oversizedSkill, body: "🎉".repeat(60), pad: zeroPad },
      }) as { success?: boolean; skill?: { body?: string } };
      expect(retained?.skill?.body).toBe(note);
      expect(JSON.stringify(retained).length).toBe(MAX_FILE_CONTENT_SIZE);

      // One char more overhead → negative budget → unretainable.
      const negative = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: { ...oversizedSkill, body: "🎉".repeat(60), pad: `${zeroPad}p` },
      });
      expect(negative).toBeUndefined();
    });

    it("retains an empty body prefix when the budget is below the first code point", () => {
      // Budget of 1 char cannot fit the leading emoji (2 serialized chars),
      // but the empty prefix + truncation note is schema-valid and fits —
      // dropping the package entirely would erase the skill from
      // post-compaction context (r23).
      const note = "\n\n[Skill body truncated at capture to fit the retained-record cap]";
      const noteChars = JSON.stringify(note).length - 2;
      const emptyBodySkill = { ...oversizedSkill, body: "", pad: "" };
      const overheadEmpty = JSON.stringify({ success: true, skill: emptyBodySkill }).length;
      const pad = "p".repeat(MAX_FILE_CONTENT_SIZE - overheadEmpty - noteChars - 1);
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: { ...oversizedSkill, body: "🎉".repeat(60), pad },
      }) as { success?: boolean; skill?: { body?: string } };
      expect(retained?.success).toBe(true);
      expect(retained?.skill?.body).toBe(note);
      expect(JSON.stringify(retained).length).toBeLessThanOrEqual(MAX_FILE_CONTENT_SIZE);
      expect(AgentSkillPackageSchema.safeParse(retained?.skill).success).toBe(true);
    });

    it("truncates escape-heavy bodies by serialized budget instead of dropping them", () => {
      // An all-newline body serializes at ~2x its raw length; a raw-length
      // budget treated that inflation as fixed overhead, went negative, and
      // lost the whole package to a marker even though a shorter serialized
      // prefix fits (r21).
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: { ...oversizedSkill, body: "\n".repeat(MAX_FILE_CONTENT_SIZE) },
      }) as { success?: boolean; skill?: { body?: string } };
      expect(retained?.success).toBe(true);
      expect(retained?.skill?.body?.startsWith("\n\n\n")).toBe(true);
      expect(
        retained?.skill?.body?.endsWith(
          "[Skill body truncated at capture to fit the retained-record cap]"
        )
      ).toBe(true);
      expect(JSON.stringify(retained).length).toBeLessThanOrEqual(MAX_FILE_CONTENT_SIZE);
      expect(AgentSkillPackageSchema.safeParse(retained?.skill).success).toBe(true);
    });
  });

  describe("file_edit_* diff bounding", () => {
    it("retains a parseable hunk-boundary prefix for oversized multi-hunk diffs", () => {
      const hunk1 = `@@ -1,0 +1,1 @@\n+${"a".repeat(30_000)}\n`;
      const diff = `Index: /x.ts\n===\n--- /x.ts\n+++ /x.ts\n${hunk1}@@ -9,0 +10,1 @@\n+${"b".repeat(30_000)}\n`;
      const retained = retainExemptKernelRecordResult("file_edit_replace_string", {
        success: true,
        diff,
      }) as { success?: boolean; diff?: string; diffTruncated?: boolean };
      expect(retained.success).toBe(true);
      expect(retained.diffTruncated).toBe(true);
      expect(retained.diff?.endsWith(hunk1)).toBe(true);
      // combineDiffs must be able to parse and apply the retained prefix.
      const patches = parsePatch(retained.diff!);
      expect(patches[0]?.hunks.length).toBe(1);
    });

    it("drops the diff but keeps the truncation flag when no whole hunk fits", () => {
      const retained = retainExemptKernelRecordResult("file_edit_insert", {
        success: true,
        diff: `@@ -1,0 +1,1 @@\n+${"g".repeat(60_000)}\n`,
      }) as { success?: boolean; diff?: string; diffTruncated?: boolean };
      expect(retained.success).toBe(true);
      expect(retained.diff).toBeUndefined();
      expect(retained.diffTruncated).toBe(true);
    });
  });

  describe("media container budgets", () => {
    it("exempts containers whose only supported media is nested inside a custom part", () => {
      // A shallow immediate-part check would decline the exemption and
      // collapse the whole result to a __kernelBounded marker, so the
      // request-time traversal would never see a payload to extract (r19).
      const nested = {
        type: "content",
        value: [
          {
            type: "custom",
            payload: {
              inner: {
                type: "content",
                value: [{ type: "media", mediaType: "image/png", data: "aGVsbG8=" }],
              },
            },
          },
        ],
      };
      const retained = retainExemptKernelRecordResult("mcp__shots__take", nested) as {
        value: Array<{ type?: string }>;
      };
      expect(retained).toBeDefined();
      expect(retained.value[0]?.type).toBe("custom");

      // Unsupported nested media alone still does NOT exempt.
      const unsupportedNested = {
        type: "content",
        value: [
          {
            type: "custom",
            payload: {
              inner: {
                type: "content",
                value: [{ type: "media", mediaType: "audio/wav", data: "d2F2" }],
              },
            },
          },
        ],
      };
      expect(retainExemptKernelRecordResult("mcp__shots__take", unsupportedNested)).toBeUndefined();

      // Standalone leaves and wrapper shapes exempt too (r24): capture
      // sanitization bounds them and request-time extraction rewrites them,
      // so declining would collapse an extractable payload to a marker.
      const rawLeaf = {
        type: "content",
        value: [
          {
            type: "custom",
            payload: { leaf: { type: "media", mediaType: "image/png", data: "aGVsbG8=" } },
          },
        ],
      };
      const retainedLeaf = retainExemptKernelRecordResult("mcp__shots__take", rawLeaf);
      expect(retainedLeaf).toBeDefined();
      const bareLeaf = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "media",
        mediaType: "image/png",
        data: "aGVsbG8=",
      }) as { data?: string };
      expect(bareLeaf?.data).toBe("aGVsbG8=");
      // Unsupported bare leaves still do not exempt.
      expect(
        retainExemptKernelRecordResult("mcp__shots__take", {
          type: "media",
          mediaType: "audio/wav",
          data: "d2F2",
        })
      ).toBeUndefined();
    });

    it("exempts media below arbitrarily deep wrappers (no depth cap)", () => {
      // The retention sanitizer walks iteratively without a depth bound
      // (r25); the exemption predicate must match (r26), or deep-wrapped
      // media would be compacted away before request-time extraction — which
      // is also unbounded over wrappers — could attach it.
      let deep: unknown = { type: "media", mediaType: "image/png", data: "aGVsbG8=" };
      for (let i = 0; i < 300; i++) deep = { next: deep };
      const retained = retainExemptKernelRecordResult("mcp__shots__take", deep);
      expect(retained).toBeDefined();
      expect(JSON.stringify(retained)).toContain("aGVsbG8=");
    });

    it("rejects junk media types at validation instead of retaining them as supported", () => {
      // transformMCPResult copies server-controlled MIME types unchanged; an
      // "image/" + megabytes string must fail isSupportedAttachmentMediaType
      // (well-formed type/subtype within the RFC-plausible length), or one
      // retained part could bloat every later provider request through
      // placeholder interpolation (round 11). The placeholder label itself
      // stays bounded.
      const junkType = `image/${"m".repeat(KERNEL_RETAINED_MEDIA_BUDGET_BYTES)}`;
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          { type: "media", mediaType: junkType, data: "aGVsbG8=" },
        ],
      }) as RetainedContainer;
      expect(retained.value[0]?.data).toBe("aGVsbG8=");
      expect(retained.value[1]?.type).toBe("text");
      expect(retained.value[1]?.text).toContain("not supported as a model attachment");
      expect(retained.value[1]?.text!.length).toBeLessThan(300);
    });

    it("charges media metadata against the budget (empty-data filename attack)", () => {
      // Payload hidden in a sibling metadata field of a well-formed part: the
      // serialized-size charge is the backstop for metadata the validator
      // cannot reject — and the placeholder must not echo the junk label.
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          {
            type: "media",
            mediaType: "image/png",
            data: "",
            filename: "m".repeat(KERNEL_RETAINED_MEDIA_BUDGET_BYTES),
          },
        ],
      }) as RetainedContainer;
      expect(retained.value[0]?.data).toBe("aGVsbG8=");
      expect(retained.value[1]?.type).toBe("text");
      expect(retained.value[1]?.text).toContain("aggregate media budget exceeded");
      expect(retained.value[1]?.text!.length).toBeLessThan(300);
    });

    it("charges the budget in UTF-8 bytes, not UTF-16 code units", () => {
      // ~1.5M CJK chars ≈ 4.5 MiB in UTF-8 history — a character-based check
      // would retain this part under the 3 MiB budget.
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          { type: "media", mediaType: "image/png", data: "", filename: "画".repeat(1_500_000) },
        ],
      }) as RetainedContainer;
      expect(retained.value[0]?.data).toBe("aGVsbG8=");
      expect(retained.value[1]?.type).toBe("text");
      expect(retained.value[1]?.text).toContain("aggregate media budget exceeded");
    });

    it("charges non-media sibling parts against the budget", () => {
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          { type: "text", text: "T".repeat(KERNEL_RETAINED_MEDIA_BUDGET_BYTES) },
        ],
      }) as RetainedContainer;
      expect(retained.value[0]?.data).toBe("aGVsbG8=");
      expect(retained.value[1]?.text).toContain("part bounded at capture");
    });

    it("caps the retained part count", () => {
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          ...Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `t${i}` })),
        ],
      }) as RetainedContainer;
      expect(retained.value.length).toBe(KERNEL_RETAINED_CONTAINER_MAX_PARTS + 1);
      expect(retained.value[KERNEL_RETAINED_CONTAINER_MAX_PARTS]?.text).toContain(
        "container part limit exceeded"
      );
    });
  });
});

describe("sanitizeMediaRecordCapture", () => {
  it("passes non-container results through untouched (non-RLM inline-results contract)", () => {
    const result = { success: true, output: "x".repeat(100_000) };
    expect(sanitizeMediaRecordCapture("bash", result)).toBe(result);
  });

  it("sanitizes containers wrapped inside return values", () => {
    // Guests can wrap bridged results (`return { image: xum.mcp(...) }`);
    // a root-only check would pass the wrapper through raw and persist
    // unbudgeted base64 (round 10).
    const audio = { type: "media", mediaType: "audio/wav", data: "d2F2".repeat(50) };
    const wrapped = { image: { type: "content", value: [audio] }, note: "kept" };
    const sanitized = sanitizeCapturedMediaValue(wrapped) as {
      image: RetainedContainer;
      note: string;
    };
    expect(sanitized.note).toBe("kept");
    expect(sanitized.image.value[0]?.type).toBe("text");
    expect(sanitized.image.value[0]?.text).toContain("not supported as a model attachment");
  });

  it("collapses placeholder floods to a single bounded marker", () => {
    // Placeholders never consume the media budget (they must always be
    // emitted), so a value flooding many media nodes could otherwise append
    // placeholder structures without bound (r24): the sanitized value gets a
    // final serialized cap.
    const leaves = Array.from({ length: 60_000 }, () => ({
      type: "media",
      mediaType: "audio/wav",
      data: "d2F2",
    }));
    const sanitized = sanitizeCapturedMediaValue({ payload: leaves });
    expect(typeof sanitized).toBe("string");
    expect(sanitized as string).toContain("exceed the remaining sanitized-value budget");
  });

  it("charges media-bearing sanitized values against the shared execution budget", () => {
    // Placeholders and non-media siblings never debit the media allowance, so
    // a per-value-only cap let a loop of calls retain another multi-megabyte
    // media-bearing record per call (r27 security): the sanitized bytes now
    // debit the shared budget and later values collapse to a small marker.
    const bigSibling = "x".repeat(4 * 1024 * 1024);
    const value = () => ({
      note: bigSibling,
      media: { type: "media", mediaType: "audio/wav", data: "d2F2" },
    });
    const shared = createCaptureSanitizerBudget();
    const first = sanitizeCapturedMediaValue(value(), shared);
    expect(typeof first).toBe("object");
    const second = sanitizeCapturedMediaValue(value(), shared);
    expect(typeof second).toBe("string");
    expect(second as string).toContain("exceed the remaining sanitized-value budget");
    // Media-free values stay uncharged and untouched (classic contract).
    const mediaFree = { note: bigSibling };
    expect(sanitizeCapturedMediaValue(mediaFree, shared)).toBe(mediaFree);
  });

  it("charges overflow markers so exhausted captures cannot accumulate free bytes", () => {
    // A media-bearing capture over the remaining allowance emits a bounded
    // marker; the marker debits the shared budget too (r28), so total marker
    // bytes stay bounded by the initial allowance.
    const shared = createCaptureSanitizerBudget();
    shared.remainingSanitizedBytes = 4;
    const out = sanitizeCapturedMediaValue(
      { media: { type: "media", mediaType: "image/png", data: "aGVsbG8=" } },
      shared
    );
    expect(typeof out).toBe("string");
    expect(shared.remainingSanitizedBytes).toBeLessThan(4);

    // Once the counter is spent, retention STOPS (r30): every further
    // media-bearing capture returns one constant stub with no further debit,
    // so a fast call loop cannot accumulate size-annotated markers or drive
    // the counter unboundedly negative.
    const exhausted = shared.remainingSanitizedBytes;
    const second = sanitizeCapturedMediaValue(
      { media: { type: "media", mediaType: "image/png", data: "aGVsbG8=" } },
      shared
    );
    expect(second).toBe(SANITIZER_BUDGET_EXHAUSTED_STUB);
    expect(shared.remainingSanitizedBytes).toBe(exhausted);
  });

  it("sanitizes standalone media leaves outside containers", () => {
    // Guest code can pluck a part out of a container (`image.value[0]`) and
    // return/log/pass it; container-only recognition would persist that copy
    // unbudgeted on every call (r23).
    const bigImage = "A".repeat(2 * 1024 * 1024);
    const leaf = () => ({ type: "media", mediaType: "image/png", data: bigImage });
    const shared = createCaptureSanitizerBudget();
    const first = sanitizeCapturedMediaValue({ payload: leaf() }, shared) as {
      payload: { type?: string; data?: string; text?: string };
    };
    const second = sanitizeCapturedMediaValue({ payload: leaf() }, shared) as {
      payload: { type?: string; text?: string };
    };
    expect(first.payload.data).toBe(bigImage);
    expect(second.payload.type).toBe("text");
    expect(second.payload.text).toContain("aggregate media budget exceeded");

    // Unsupported standalone leaves are always replaced.
    const audio = sanitizeCapturedMediaValue({
      payload: { type: "media", mediaType: "audio/wav", data: "d2F2".repeat(50) },
    }) as { payload: { type?: string; text?: string } };
    expect(audio.payload.type).toBe("text");
    expect(audio.payload.text).toContain("not supported as a model attachment");
  });

  it("shares a caller-provided budget across separate captures", () => {
    // Classic mode passes ONE budget per execution (r19): without sharing,
    // each call would mint a fresh allowance and a loop of bridged media
    // calls could persist unbounded multi-megabyte records.
    const bigImage = "A".repeat(2 * 1024 * 1024);
    const container = () => ({
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: bigImage }],
    });
    const shared = createCaptureSanitizerBudget();
    const first = sanitizeCapturedMediaValue(container(), shared) as RetainedContainer;
    const second = sanitizeCapturedMediaValue(container(), shared) as RetainedContainer;
    expect(first.value[0]?.data).toBe(bigImage);
    expect(second.value[0]?.type).toBe("text");
    expect(second.value[0]?.text).toContain("aggregate media budget exceeded");
  });

  it("shares one aggregate budget across all containers in a value", () => {
    // Wrapping N containers must not multiply the bound: two ~2MiB images in
    // separate wrapped containers exceed one shared 3MiB budget.
    const bigImage = "A".repeat(2 * 1024 * 1024);
    const container = () => ({
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: bigImage }],
    });
    const sanitized = sanitizeCapturedMediaValue({ a: container(), b: container() }) as {
      a: RetainedContainer;
      b: RetainedContainer;
    };
    expect(sanitized.a.value[0]?.data).toBe(bigImage);
    expect(sanitized.b.value[0]?.type).toBe("text");
    expect(sanitized.b.value[0]?.text).toContain("aggregate media budget exceeded");
  });

  it("bounds cyclic and deeply nested media values instead of hanging or leaking", () => {
    const audio = { type: "media", mediaType: "audio/wav", data: "d2F2" };
    const cyclic: Record<string, unknown> = { container: { type: "content", value: [audio] } };
    cyclic.self = cyclic;
    const sanitizedCycle = sanitizeCapturedMediaValue(cyclic) as Record<string, unknown>;
    expect(sanitizedCycle.self).toBe("[cyclic value bounded at capture]");
    expect((sanitizedCycle.container as RetainedContainer).value[0]?.type).toBe("text");

    // A media container buried under many wrapper levels is still found and
    // sanitized — the iterative walk has no depth limit to smuggle past (r25).
    let deep: unknown = { type: "content", value: [audio] };
    for (let i = 0; i < 300; i++) deep = { next: deep };
    const sanitizedDeep = JSON.stringify(sanitizeCapturedMediaValue(deep));
    expect(sanitizedDeep).toContain("not supported as a model attachment");
    expect(sanitizedDeep).not.toContain("d2F2");
  });

  it("preserves media-free deep values with identity intact", () => {
    // Classic mode keeps full inline results/args by contract: depth-based
    // replacement of legitimate media-free deep JSON silently truncated real
    // output (r25).
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 300; i++) deep = { next: deep };
    expect(sanitizeCapturedMediaValue(deep)).toBe(deep);
  });

  it("bounds containers holding only unsupported media", () => {
    // containsMediaContentPayload would NOT exempt this container (no
    // supported media), but the mode-independent sanitizer must still bound
    // it: classic mode would otherwise persist the raw base64 into records.
    const sanitized = sanitizeMediaRecordCapture("mcp__rec__capture", {
      type: "content",
      value: [{ type: "media", mediaType: "audio/wav", data: "d2F2".repeat(50) }],
    }) as RetainedContainer;
    expect(sanitized.value[0]?.type).toBe("text");
    expect(sanitized.value[0]?.text).toContain("not supported as a model attachment");
  });
});

describe("retainPersistenceCriticalArgsFields", () => {
  it("preserves the validated path for file_edit tools", () => {
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", {
        path: "/a.ts",
        content: "x".repeat(5_000),
      })
    ).toEqual({ path: "/a.ts" });
  });

  it("returns undefined for non-persistence-critical tools and unusable paths", () => {
    expect(retainPersistenceCriticalArgsFields("bash", { path: "/a.ts" })).toBeUndefined();
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", "not-an-object")
    ).toBeUndefined();
    // A path longer than any real filesystem path is guest junk: dropping it
    // beats recording a truncated (wrong) attribution.
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", { path: "p".repeat(5_000) })
    ).toBeUndefined();
  });

  it("bounds retained paths by serialized bytes, not UTF-16 code units", () => {
    // 2000 three-byte code points sit under a 4096 code-unit count but
    // serialize to ~6 KB, and JSON escaping expands lone surrogates 6x — a
    // code-unit cap would merge ~24 KiB onto the 2 KiB args marker (r26).
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", { path: "\u96EA".repeat(2_000) })
    ).toBeUndefined();
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", { path: "\uD800".repeat(1_000) })
    ).toBeUndefined();
  });

  it("retains script_path for workflow_run launch args", () => {
    expect(
      retainPersistenceCriticalArgsFields("workflow_run", {
        script_path: "skill://demo/workflow.js",
        args: { problem: "x".repeat(5_000) },
      })
    ).toEqual({ script_path: "skill://demo/workflow.js" });
    // Inline-source launches have no path to retain.
    expect(
      retainPersistenceCriticalArgsFields("workflow_run", {
        script_source: "export default function workflow() {}",
      })
    ).toBeUndefined();
    expect(
      retainPersistenceCriticalArgsFields("workflow_run", { script_path: "p".repeat(5_000) })
    ).toBeUndefined();
  });
});

describe("retainWorkflowResultIdentityFields", () => {
  it("retains runId and validated status for workflow tools", () => {
    expect(
      retainWorkflowResultIdentityFields("workflow_run", {
        status: "completed",
        runId: "wfr_1",
        result: { reportMarkdown: "big" },
      })
    ).toEqual({ runId: "wfr_1", status: "completed" });
    expect(
      retainWorkflowResultIdentityFields("workflow_resume", { status: "running", runId: "wfr_2" })
    ).toEqual({ runId: "wfr_2", status: "running" });
  });

  it("drops non-workflow tools, missing runIds, and invalid statuses", () => {
    expect(
      retainWorkflowResultIdentityFields("bash", { runId: "wfr_1", status: "completed" })
    ).toBeUndefined();
    expect(
      retainWorkflowResultIdentityFields("workflow_run", { status: "completed" })
    ).toBeUndefined();
    expect(retainWorkflowResultIdentityFields("workflow_run", "not-an-object")).toBeUndefined();
    // A guest-spoofable status is validated; the runId still survives alone.
    expect(
      retainWorkflowResultIdentityFields("workflow_run", { runId: "wfr_1", status: "exploded" })
    ).toEqual({ runId: "wfr_1" });
    expect(
      retainWorkflowResultIdentityFields("workflow_run", { runId: "r".repeat(5_000) })
    ).toBeUndefined();
  });
});
