import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { jsonSchema, tool } from "ai";
import * as tokenizerModule from "@/node/utils/main/tokenizer";
import {
  estimateAssembledRequestTokens,
  getContextBudgetHardCeiling,
} from "@/common/utils/compaction/contextBudget";
import {
  checkAssembledRequestBudgetForModel,
  estimateFreshRequestTokensForModel,
  estimateToolResultTokensForModel,
} from "./contextBudgetCounting";

const model = "openai:gpt-4o";
afterEach(() => mock.restore());

describe("real-encoding budget guards", () => {
  test.each([
    { name: "empty arrays", value: Array.from({ length: 10000 }, () => []) },
    { name: "empty objects", value: Array.from({ length: 10000 }, () => ({})) },
    { name: "escaped controls", value: { ["\u0000".repeat(1000)]: "\u0000".repeat(6000) } },
  ])("JSON $name cannot evade settled or assembled token budgets", async ({ value }) => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    const direct = await tokenizer.countTokens(JSON.stringify(value));
    const limit = 12000;
    expect(direct).toBeGreaterThan(getContextBudgetHardCeiling(limit));
    expect(await estimateToolResultTokensForModel(value, { model })).toBeGreaterThanOrEqual(direct);
    const payload = {
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "structured",
              toolName: "read",
              output: { type: "json", value },
            },
          ],
        },
      ],
    };
    expect(
      (await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: limit }))
        ?.type
    ).toBe("context_budget_exceeded");
  });

  test("structure-only aliases remain bounded and cycles do not hide visible escaped text", async () => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    const count = spyOn(tokenizer, "countTokens");
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValue(tokenizer);
    const shared: unknown[] = [];
    const aliases = Array.from({ length: 1500 }, () => shared);
    const encoded = await tokenizer.countTokens(JSON.stringify(aliases));
    count.mockClear();
    expect(await estimateToolResultTokensForModel(aliases, { model })).toBeGreaterThanOrEqual(
      encoded
    );
    expect(count.mock.calls.length).toBeLessThanOrEqual(1);
    const cyclic: { value: string; self?: unknown } = { value: "\u0000".repeat(1000) };
    const plain = await estimateToolResultTokensForModel(cyclic, { model });
    cyclic.self = cyclic;
    const withCycle = await estimateToolResultTokensForModel(cyclic, { model });
    expect(withCycle).toBeGreaterThanOrEqual(plain);
    expect(Number.isFinite(withCycle)).toBe(true);
  });

  test("bypass warmed approx-4 without changing ordinary callers for CJK, emoji and dense identifiers", async () => {
    const keys = [
      "XUM_APPROX_TOKENIZER",
      "MUX_APPROX_TOKENIZER",
      "XUM_FORCE_REAL_TOKENIZER",
      "MUX_FORCE_REAL_TOKENIZER",
    ] as const;
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.XUM_APPROX_TOKENIZER = "1";
      delete process.env.XUM_FORCE_REAL_TOKENIZER;
      delete process.env.MUX_FORCE_REAL_TOKENIZER;
      const approximate = await tokenizerModule.getTokenizerForModel(model);
      expect(approximate.encoding).toBe("approx-4");
      const limit = 10000;
      const ceiling = getContextBudgetHardCeiling(limit);
      for (const text of ["漢".repeat(10000), "🦊".repeat(4000), "a0b1c2d3e4f5".repeat(1500)]) {
        const warmCount = await approximate.countTokens(text);
        const payload = { system: "Short system", messages: [{ role: "user", content: text }] };
        expect(warmCount).toBeLessThan(ceiling);
        expect(estimateAssembledRequestTokens(payload)).toBeLessThan(ceiling);
        const rejected = await checkAssembledRequestBudgetForModel(payload, {
          model,
          modelContextLimit: limit,
        });
        expect(rejected?.type).toBe("context_budget_exceeded");
        expect(rejected?.estimate).toBeGreaterThan(ceiling);
        expect(
          await estimateFreshRequestTokensForModel(
            { userText: text, systemFloorTokens: 0, modelContextLimit: limit },
            { model }
          )
        ).toBeGreaterThan(ceiling);
        const stillApproximate = await tokenizerModule.getTokenizerForModel(model);
        expect(stillApproximate.encoding).toBe("approx-4");
        expect(await stillApproximate.countTokens(text)).toBe(warmCount);
      }
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  }, 20000);

  test("ordinary fitting ASCII/CJK prompts and ASCII schemas stay usable", async () => {
    const payload = {
      system: "Follow the project conventions. ".repeat(20),
      messages: [{ role: "user", content: "你好，请解释这个函数。" }],
      tools: {
        inspect: tool({
          description: "Inspect project code. ".repeat(100),
          inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } } }),
        }),
      },
    };
    expect(
      await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: 10000 })
    ).toBeUndefined();
    expect(
      await estimateFreshRequestTokensForModel(
        { userText: "Explain this function.", modelContextLimit: 4096 },
        { model }
      )
    ).toBeLessThan(getContextBudgetHardCeiling(4096));
  });

  test("counts system/schema text but excludes nested media bytes", async () => {
    const count = (bytes: string) =>
      estimateToolResultTokensForModel(
        { data: [{ type: "media", data: bytes, mediaType: "image/png" }] },
        { model }
      );
    expect(await count("x".repeat(100000))).toBe(await count("abc"));
    const payload = {
      messages: [{ role: "user", content: "small" }],
      tools: {
        huge: tool({
          description: "漢".repeat(10000),
          inputSchema: jsonSchema({ type: "object" }),
        }),
      },
    };
    expect(
      (await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: 10000 }))
        ?.type
    ).toBe("context_budget_exceeded");
  });

  test.each(["user", "tool-text", "json-image", "json-file", "json-message"] as const)(
    "data URLs remain counted text in %s rather than impersonating media",
    async (kind) => {
      const data = "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000);
      const output =
        kind === "tool-text"
          ? { type: "text", value: data }
          : {
              type: "json",
              value:
                kind === "json-image"
                  ? { type: "image", image: data, data, mimeType: "image/png" }
                  : kind === "json-file"
                    ? { type: "file", url: data, data, mediaType: "image/png" }
                    : { role: "user", content: [{ type: "image", image: data }] },
            };
      const payload = {
        messages:
          kind === "user"
            ? [{ role: "user", content: data }]
            : [
                {
                  role: "tool",
                  content: [
                    { type: "tool-result", toolCallId: "result", toolName: "read", output },
                  ],
                },
              ],
      };
      expect(
        (await checkAssembledRequestBudgetForModel(payload, { model, modelContextLimit: 10000 }))
          ?.type
      ).toBe("context_budget_exceeded");
      if (kind === "user")
        expect(
          await estimateFreshRequestTokensForModel(
            { userText: data, systemFloorTokens: 0, modelContextLimit: 10000 },
            { model }
          )
        ).toBeGreaterThan(getContextBudgetHardCeiling(10000));
      else
        expect(await estimateToolResultTokensForModel(output, { model })).toBeGreaterThan(
          getContextBudgetHardCeiling(10000)
        );
    }
  );

  test.each(["image-data", "file-data", "image-url", "file-url", "file"] as const)(
    "only actual SDK content outputs give %s payloads media semantics",
    async (type) => {
      const data = "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000);
      const part =
        type === "file"
          ? { type, mediaType: "image/png", data: { type: "data", data } }
          : type.endsWith("-url")
            ? { type, url: data, mediaType: "image/png" }
            : { type, data, mediaType: "image/png" };
      const content = { type: "content", value: [part] };
      const payload = (output: unknown) => ({
        messages: [
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "result", toolName: "read", output }],
          },
        ],
      });
      expect(
        await checkAssembledRequestBudgetForModel(payload(content), {
          model,
          modelContextLimit: 10000,
        })
      ).toBeUndefined();
      expect(
        (
          await checkAssembledRequestBudgetForModel(payload({ type: "json", value: content }), {
            model,
            modelContextLimit: 10000,
          })
        )?.type
      ).toBe("context_budget_exceeded");
    }
  );

  test("SDK inline text-file data remains text rather than an image allowance", async () => {
    expect(
      (
        await checkAssembledRequestBudgetForModel(
          {
            messages: [
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "result",
                    toolName: "read",
                    output: {
                      type: "content",
                      value: [
                        {
                          type: "file",
                          mediaType: "text/plain",
                          data: {
                            type: "text",
                            text: "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
          { model, modelContextLimit: 10000 }
        )
      )?.type
    ).toBe("context_budget_exceeded");
  });

  test("a shared media-shaped object still counts as text when serialized inside tool JSON", async () => {
    const image = { type: "image", image: "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000) };
    expect(
      (
        await checkAssembledRequestBudgetForModel(
          {
            messages: [
              { role: "user", content: [image] },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "result",
                    toolName: "read",
                    output: { type: "json", value: image },
                  },
                ],
              },
            ],
          },
          { model, modelContextLimit: 10000 }
        )
      )?.type
    ).toBe("context_budget_exceeded");
  });

  test.each(["image", "file"] as const)(
    "genuine model %s parts stay bounded but their extra text does not",
    async (type) => {
      const payload = (data: string) => ({
        messages: [
          {
            role: "user",
            content: [
              type === "image"
                ? { type, image: data }
                : { type, data, mediaType: "application/pdf" },
            ],
          },
        ],
      });
      for (const data of [
        "data:image/png;base64,abc",
        "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000),
      ]) {
        expect(
          await checkAssembledRequestBudgetForModel(payload(data), {
            model,
            modelContextLimit: 10000,
          })
        ).toBeUndefined();
      }
      expect(
        (
          await checkAssembledRequestBudgetForModel(
            {
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type,
                      data: "abc",
                      image: "abc",
                      mediaType: "image/png",
                      caption: "data:image/png;base64," + "a0b1c2d3e4f5".repeat(2000),
                    },
                  ],
                },
              ],
            },
            { model, modelContextLimit: 10000 }
          )
        )?.type
      ).toBe("context_budget_exceeded");
    }
  );

  test("bounded chunk counts cover direct encoding around Unicode and identifier boundaries", async () => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    for (const text of [
      "a".repeat(4095) + "🦊漢字".repeat(100),
      "a0b1c2d3e4f5".repeat(500),
      "你好世界".repeat(1300),
    ]) {
      const direct = await tokenizer.countTokens(text);
      expect(await estimateToolResultTokensForModel(text, { model })).toBeGreaterThanOrEqual(
        direct
      );
    }
  }, 10000);

  test("huge repeated ASCII completes with bounded real-encoding calls", async () => {
    const tokenizer = await tokenizerModule.getTokenizerForModel(model, undefined, {
      requireRealEncoding: true,
    });
    const count = spyOn(tokenizer, "countTokens");
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValue(tokenizer);
    const rejected = await checkAssembledRequestBudgetForModel(
      { system: "x".repeat(1_500_000), messages: [] },
      { model, modelContextLimit: 10000 }
    );
    expect(rejected?.type).toBe("context_budget_exceeded");
    expect(count.mock.calls.length).toBeLessThan(30);
    expect(
      count.mock.calls.every(
        ([text]) => text.length <= 4096 && Buffer.from(text).toString("utf8") === text
      )
    ).toBe(true);
  }, 10000);

  test("encoding initialization and counting failures do not downgrade to character heuristics", async () => {
    const failure = new Error("encoding unavailable");
    spyOn(tokenizerModule, "getTokenizerForModel").mockRejectedValueOnce(failure);
    expect(
      await estimateFreshRequestTokensForModel({ userText: "hello" }, { model }).catch(
        (error: unknown) => error
      )
    ).toBe(failure);
    spyOn(tokenizerModule, "getTokenizerForModel").mockResolvedValueOnce({
      encoding: "real",
      countTokens: () => Promise.reject(failure),
    });
    expect(
      await checkAssembledRequestBudgetForModel(
        { messages: [{ role: "user", content: "hello" }] },
        { model, modelContextLimit: 10000 }
      ).catch((error: unknown) => error)
    ).toBe(failure);
  });
});
