import { describe, expect, test } from "bun:test";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { parseCommandWithSkillInvocation } from "./utils";

function descriptor(name: string): AgentSkillDescriptor {
  return { name, description: `${name} description`, scope: "project" };
}

describe("parseCommandWithSkillInvocation one-shot composition", () => {
  test("composes '/haiku+0 /done args' into a skill invocation with a one-shot override", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/haiku+0 /done now please",
      agentSkillDescriptors: [descriptor("done")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });

    expect(result.parsed).toBeNull();
    expect(result.skillInvocation?.descriptor.name).toBe("done");
    expect(result.skillInvocation?.userText).toBe("Using skill done: now please");
    // Arguments are relative to the skill token so $ARGUMENTS substitution
    // sees "now please", not the one-shot prefix.
    expect(result.skillInvocation?.argumentText).toBe("now please");
    expect(result.skillInvocation?.oneShot).toEqual({
      modelString: KNOWN_MODELS.HAIKU.id,
      thinkingLevel: 0,
    });
  });

  test("composes a thinking-only override ('/+2 /done')", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/+2 /done",
      agentSkillDescriptors: [descriptor("done")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });

    expect(result.parsed).toBeNull();
    expect(result.skillInvocation?.userText).toBe("Use skill done");
    expect(result.skillInvocation?.oneShot).toEqual({ thinkingLevel: 2 });
  });

  test("does not compose without the composeOneShot opt-in (creation composer)", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/haiku+0 /done now",
      agentSkillDescriptors: [descriptor("done")],
      api: null,
      discovery: null,
    });

    expect(result.skillInvocation).toBeNull();
    expect(result.parsed?.type).toBe("model-oneshot");
  });

  test("keeps valid registered-command invocations out of composition ('/haiku+0 /compact')", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/haiku+0 /compact",
      agentSkillDescriptors: [descriptor("compact")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });

    expect(result.skillInvocation).toBeNull();
    expect(result.parsed).toMatchObject({ type: "model-oneshot", message: "/compact" });
  });

  test("mirrors direct invocation for unknown-command remainders, even on command-colliding names", async () => {
    // "/compact now" is an invalid compact usage: its handler returns
    // unknown-command, and unknown commands are exactly what skill invocation
    // consumes. Direct typing already resolves a skill named "compact" here,
    // so the composed form must behave identically.
    const direct = await parseCommandWithSkillInvocation({
      messageText: "/compact now",
      agentSkillDescriptors: [descriptor("compact")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });
    const composed = await parseCommandWithSkillInvocation({
      messageText: "/haiku+0 /compact now",
      agentSkillDescriptors: [descriptor("compact")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });

    expect(direct.skillInvocation?.descriptor.name).toBe("compact");
    expect(composed.skillInvocation?.descriptor.name).toBe("compact");
    expect(composed.skillInvocation?.oneShot).toEqual({
      modelString: KNOWN_MODELS.HAIKU.id,
      thinkingLevel: 0,
    });
  });

  test("keeps nested one-shots out of composition ('/haiku+0 /opus hi')", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/haiku+0 /opus hi",
      agentSkillDescriptors: [descriptor("done")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });

    expect(result.skillInvocation).toBeNull();
    expect(result.parsed).toMatchObject({ type: "model-oneshot", message: "/opus hi" });
  });

  test("falls back to a plain one-shot when the remainder is not a known skill", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/haiku+0 /nothere do it",
      agentSkillDescriptors: [descriptor("done")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });

    expect(result.skillInvocation).toBeNull();
    expect(result.parsed).toMatchObject({ type: "model-oneshot", message: "/nothere do it" });
  });

  test("plain skill invocations are unaffected by the composition flag", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/done now",
      agentSkillDescriptors: [descriptor("done")],
      api: null,
      discovery: null,
      composeOneShot: true,
    });

    expect(result.parsed).toBeNull();
    expect(result.skillInvocation?.descriptor.name).toBe("done");
    expect(result.skillInvocation?.oneShot).toBeUndefined();
  });
});
