import { describe, it, expect } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { parseCommand } from "./parser";

// Test helpers
const expectParse = (input: string, expected: ReturnType<typeof parseCommand>) => {
  expect(parseCommand(input)).toEqual(expected);
};

const expectModelSet = (input: string, modelString: string) => {
  expectParse(input, { type: "model-set", modelString });
};

describe("commandParser", () => {
  describe("parseCommand", () => {
    it("should return null for non-command input", () => {
      expect(parseCommand("hello world")).toBeNull();
      expect(parseCommand("")).toBeNull();
      expect(parseCommand(" ")).toBeNull();
    });

    it("should parse /clear command", () => {
      expectParse("/clear", { type: "clear", mode: "hard" });
    });

    it("should parse /clear --soft command", () => {
      expectParse("/clear --soft", { type: "clear", mode: "soft" });
    });

    it("should reject unknown /clear flags", () => {
      expectParse("/clear --unknown", {
        type: "unknown-command",
        command: "clear",
        subcommand: "--unknown",
      });
    });

    it("parses /refine and exact '/refine apply', rejecting all other arguments", () => {
      expectParse("/refine", { type: "refine" });
      expectParse("/refine apply", { type: "refine", apply: true });
      // Mistyped approvals must NOT fall through to a fresh run — that would
      // overwrite the staged proposal the user meant to approve and incur
      // another model call.
      expectParse("/refine Apply", {
        type: "unknown-command",
        command: "refine",
        subcommand: "Apply",
      });
      expectParse("/refine apply now", {
        type: "unknown-command",
        command: "refine",
        subcommand: "apply now",
      });
    });

    it("treats removed /providers command as unknown", () => {
      expectParse("/providers", {
        type: "unknown-command",
        command: "providers",
        subcommand: undefined,
      });
    });

    it("should parse unknown commands", () => {
      expectParse("/foo", {
        type: "unknown-command",
        command: "foo",
        subcommand: undefined,
      });

      expectParse("/foo bar", {
        type: "unknown-command",
        command: "foo",
        subcommand: "bar",
      });
    });

    it("should parse /model with abbreviation", () => {
      expectModelSet("/model opus", KNOWN_MODELS.OPUS.id);
    });

    it("should parse /model with full provider:model format", () => {
      expectModelSet("/model anthropic:claude-sonnet-5", KNOWN_MODELS.SONNET.id);
    });

    it("should parse /compact -m with alias", () => {
      expectParse("/compact -m sonnet", {
        type: "compact",
        maxOutputTokens: undefined,
        continueMessage: undefined,
        model: KNOWN_MODELS.SONNET.id,
      });
    });

    it("should parse /model help when no args", () => {
      expectParse("/model", { type: "model-help" });
    });

    it("should handle unknown abbreviation as full model string", () => {
      expectModelSet("/model custom:model-name", "custom:model-name");
    });

    it("should reject /model with too many arguments", () => {
      expectParse("/model anthropic claude extra", {
        type: "unknown-command",
        command: "model",
        subcommand: "claude",
      });
    });

    it("should parse /<model-alias> as model-oneshot with message", () => {
      expectParse("/haiku check the pr", {
        type: "model-oneshot",
        modelString: KNOWN_MODELS.HAIKU.id,
        message: "check the pr",
      });
    });

    it("should parse /<model-alias> with multiline message", () => {
      expectParse("/sonnet first line\nsecond line", {
        type: "model-oneshot",
        modelString: KNOWN_MODELS.SONNET.id,
        message: "first line\nsecond line",
      });
    });

    it("should return model-help for /<model-alias> without message", () => {
      expectParse("/haiku", { type: "model-help" });
      expectParse("/sonnet  ", { type: "model-help" }); // whitespace only
    });

    it("should return unknown-command for unknown aliases", () => {
      expectParse("/xyz do something", {
        type: "unknown-command",
        command: "xyz",
        subcommand: "do",
      });
    });

    it("should not treat inherited properties as model aliases", () => {
      // Ensures we use Object.hasOwn to avoid prototype chain lookups
      expectParse("/toString hello", {
        type: "unknown-command",
        command: "toString",
        subcommand: "hello",
      });
      expectParse("/constructor test", {
        type: "unknown-command",
        command: "constructor",
        subcommand: "test",
      });
    });

    it("treats inherited properties as literal model inputs", () => {
      expectParse("/model toString", { type: "model-set", modelString: "toString" });
      expectParse("/compact -m toString", {
        type: "compact",
        maxOutputTokens: undefined,
        continueMessage: undefined,
        model: "toString",
      });
    });

    it("should parse /vim command", () => {
      expectParse("/vim", { type: "vim-toggle" });
    });

    it("should reject /vim with arguments", () => {
      expectParse("/vim enable", {
        type: "unknown-command",
        command: "vim",
        subcommand: "enable",
      });
    });

    it("should parse /fork with no args (seamless fork)", () => {
      expectParse("/fork", { type: "fork" });
    });

    it("should parse /fork with start message", () => {
      expectParse("/fork let's explore this idea", {
        type: "fork",
        startMessage: "let's explore this idea",
      });
    });
  });
});

describe("thinking oneshot (/model+level syntax)", () => {
  it("parses /opus+2 as model + numeric thinking index", () => {
    expectParse("/opus+2 deep review", {
      type: "model-oneshot",
      modelString: KNOWN_MODELS.OPUS.id,
      thinkingLevel: 2, // Numeric: resolved against model policy at send time
      message: "deep review",
    });
  });

  it("parses /haiku+0 as model with thinking at lowest level", () => {
    expectParse("/haiku+0 quick answer", {
      type: "model-oneshot",
      modelString: KNOWN_MODELS.HAIKU.id,
      thinkingLevel: 0, // Numeric: resolved to model's lowest allowed level at send time
      message: "quick answer",
    });
  });

  it("parses /sonnet+high with named thinking level", () => {
    expectParse("/sonnet+high analyze this", {
      type: "model-oneshot",
      modelString: KNOWN_MODELS.SONNET.id,
      thinkingLevel: "high",
      message: "analyze this",
    });
  });

  it("parses /haiku+med with shorthand thinking level", () => {
    expectParse("/haiku+med fast check", {
      type: "model-oneshot",
      modelString: KNOWN_MODELS.HAIKU.id,
      thinkingLevel: "medium",
      message: "fast check",
    });
  });

  it("parses /+0 as thinking-only override (no model)", () => {
    expectParse("/+0 quick question", {
      type: "model-oneshot",
      thinkingLevel: 0, // Numeric: resolved at send time
      message: "quick question",
    });
  });

  it("parses /+high as thinking-only override with named level", () => {
    expectParse("/+high deep thought", {
      type: "model-oneshot",
      thinkingLevel: "high",
      message: "deep thought",
    });
  });

  it("parses /+4 as thinking-only override (numeric)", () => {
    expectParse("/+4 analyze deeply", {
      type: "model-oneshot",
      thinkingLevel: 4, // Numeric: resolved at send time
      message: "analyze deeply",
    });
  });

  it("returns model-help for /opus+2 without message", () => {
    expectParse("/opus+2", { type: "model-help" });
    expectParse("/+0", { type: "model-help" });
    expectParse("/+high  ", { type: "model-help" });
  });

  it("returns unknown-command for invalid thinking level", () => {
    expectParse("/opus+99 do something", {
      type: "unknown-command",
      command: "opus+99",
      subcommand: "do",
    });
  });

  it("returns unknown-command for unknown model with +level", () => {
    expectParse("/xyz+2 do something", {
      type: "unknown-command",
      command: "xyz+2",
      subcommand: "do",
    });
  });

  it("returns unknown-command for bare + with no level", () => {
    expectParse("/haiku+ do something", {
      type: "unknown-command",
      command: "haiku+",
      subcommand: "do",
    });
  });

  it("preserves multiline messages with thinking oneshot", () => {
    expectParse("/opus+high first line\nsecond line", {
      type: "model-oneshot",
      modelString: KNOWN_MODELS.OPUS.id,
      thinkingLevel: "high",
      message: "first line\nsecond line",
    });
  });
});

it("treats text after /new as the start message (no workspace name required)", () => {
  expectParse("/new\nBuild authentication system", {
    type: "new",
    startMessage: "Build authentication system",
  });
});

it("collapses multiline /new input into a single start message", () => {
  // /new now mirrors /fork: the entire payload is the start message and the
  // backend handles workspace naming + (optional) auto-title generation.
  expectParse("/new Build feature X\nWith follow-up details", {
    type: "new",
    startMessage: "Build feature X\nWith follow-up details",
  });
});

describe("plan commands", () => {
  it("should parse /plan as plan-show", () => {
    expectParse("/plan", { type: "plan-show" });
  });

  it("should parse /plan open as plan-open", () => {
    expectParse("/plan open", { type: "plan-open" });
  });

  it("should return unknown-command for invalid /plan subcommand", () => {
    expectParse("/plan invalid", {
      type: "unknown-command",
      command: "plan",
      subcommand: "invalid",
    });
  });
});

describe("init command", () => {
  it("parses explicit workflow script path invocation", () => {
    expect(parseCommand('/workflow skill://deep-research/workflow.js {"topic":"mux"}')).toEqual({
      type: "workflow-run",
      scriptPath: "skill://deep-research/workflow.js",
      argsText: '{"topic":"mux"}',
    });
  });

  it("should parse /init as unknown-command (handled as a skill invocation)", () => {
    expectParse("/init", {
      type: "unknown-command",
      command: "init",
      subcommand: undefined,
    });
  });

  it("should parse /init with arguments as unknown-command", () => {
    expectParse("/init extra", {
      type: "unknown-command",
      command: "init",
      subcommand: "extra",
    });
  });
});
