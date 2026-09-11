import { describe, expect, it } from "bun:test";
import { GitProgressParser } from "./gitProgress";

function createParser() {
  const progress: Array<{ stage: string; percent: number }> = [];
  const output: string[] = [];
  const parser = new GitProgressParser(
    (stage, percent) => progress.push({ stage, percent }),
    (line) => output.push(line)
  );
  return { parser, progress, output };
}

describe("GitProgressParser", () => {
  it("buffers partial chunks and handles carriage returns and newlines", () => {
    const { parser, progress, output } = createParser();
    parser.push("Updating fi");
    parser.push("les:  1");
    expect(progress).toEqual([]);
    parser.push("2% (12/100)\rUpdating files: 34% (34/100)\n");
    expect(progress).toEqual([
      { stage: "Updating files", percent: 12 },
      { stage: "Updating files", percent: 34 },
    ]);
    expect(output).toEqual(["Updating files: 34% (34/100)"]);
  });

  it("deduplicates percentages while allowing a new stage at the same percentage", () => {
    const { parser, progress } = createParser();
    parser.push("Updating files: 50% (5/10)\rUpdating files: 50% (50/100)\r");
    parser.push("Filtering content: 50% (1/2)\rFiltering content: 75% (3/4)\r");
    expect(progress).toEqual([
      { stage: "Updating files", percent: 50 },
      { stage: "Filtering content", percent: 50 },
      { stage: "Filtering content", percent: 75 },
    ]);
  });

  it("keeps final done lines as raw output without repeating 100 percent", () => {
    const { parser, progress, output } = createParser();
    parser.push("Updating files: 100% (10/10)\r");
    parser.push("Updating files: 100% (10/10), done.\r");
    parser.push("\nFiltering content: 100% (2/2), done.\n");
    expect(progress).toEqual([
      { stage: "Updating files", percent: 100 },
      { stage: "Filtering content", percent: 100 },
    ]);
    expect(output).toEqual([
      "Updating files: 100% (10/10), done.",
      "Filtering content: 100% (2/2), done.",
    ]);
  });

  it("preserves raw diagnostics and flushes an unterminated line only once", () => {
    const { parser, progress, output } = createParser();
    parser.push("warning: low disk space\r\n\n  extra detail\nfa");
    parser.push("tal: checkout failed");
    expect(output).toEqual(["warning: low disk space", "  extra detail"]);
    parser.flush();
    parser.flush();
    expect(output).toEqual(["warning: low disk space", "  extra detail", "fatal: checkout failed"]);
    expect(progress).toEqual([]);
  });

  it("flushes a partial progress record as raw output instead of guessing completion", () => {
    const { parser, progress, output } = createParser();
    parser.push("Updating files: 80% (8/10)");
    parser.flush();
    expect(progress).toEqual([]);
    expect(output).toEqual(["Updating files: 80% (8/10)"]);
  });
});
