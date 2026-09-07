import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTheme, projectTheme } from "./generateTheme.cjs";

const temporaryDirectories: string[] = [];
afterEach(() =>
  temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true }))
);

function project(declarations: string) {
  return projectTheme(`:root { @theme { ${declarations} } }`, { accent: "--accent" }).accent;
}

test("canonical edits and recursive aliases propagate while theme overrides stay excluded", () => {
  const css = ":root { @theme { --base: #123; --alias: var(--base); --accent: var(--alias); } }";
  expect(projectTheme(css, { accent: "--accent" }).accent).toBe("rgba(17, 34, 51, 1)");
  expect(projectTheme(css.replace("#123", "#456"), { accent: "--accent" }).accent).toBe(
    "rgba(68, 85, 102, 1)"
  );
  expect(
    projectTheme(css + ':root[data-theme="light"] { --base: #fff; }', { accent: "--accent" }).accent
  ).toBe("rgba(17, 34, 51, 1)");
});

test.each([
  ["#1234", "rgba(17, 34, 51, 0.266667)"],
  ["#12345680", "rgba(18, 52, 86, 0.501961)"],
  ["hsl(210 100% 50% / 25%)", "rgba(0, 128, 255, 0.25)"],
  ["hsla(210, 100%, 50%, 0.4)", "rgba(0, 128, 255, 0.4)"],
  ["hsla(0, 0%, 50%)", "rgba(128, 128, 128, 1)"],
  ["rgb(100% 0% 0% / .2)", "rgba(255, 0, 0, 0.2)"],
  ["rgba(1, 2, 3, 0.75)", "rgba(1, 2, 3, 0.75)"],
  ["hsl(-120deg 100% 50%)", "rgba(0, 0, 255, 1)"],
])("normalizes %s into native-safe color syntax", (input, expected) => {
  expect(project(`--accent: ${input};`)).toBe(expected);
});

test("semantic opacity derives its hue from the canonical token", () => {
  const tokens = { surface: { token: "--accent", alpha: 0.12 } };
  const css = ":root { @theme { --accent: #123; } }";
  expect(projectTheme(css, tokens).surface).toBe("rgba(17, 34, 51, 0.12)");
  expect(projectTheme(css.replace("#123", "#abc"), tokens).surface).toBe(
    "rgba(170, 187, 204, 0.12)"
  );
});

test.each([
  ["", /Missing theme token/],
  ["--accent: var(--missing);", /Missing theme token/],
  ["--accent: var(--alias); --alias: var(--accent);", /cycle/],
  ["--accent: color-mix(in srgb, red, blue);", /Unsupported/],
  ["--accent: hsl(from red h s l);", /Unsupported/],
  ["--accent: rgba(0, 0, 0, 2);", /range/],
  ["--accent: hsl(0 101% 50%);", /range/],
  [`--accent: hsl(${"9".repeat(400)} 100% 50%);`, /Unsupported hue/],
])("rejects invalid projected declarations: %s", (declarations, error) => {
  expect(() => project(declarations)).toThrow(error);
});

test("drift checks never mutate output, and write mode leaves current files untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "mobile-theme-test-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "globals.css");
  const outputPath = join(directory, "colors.ts");
  const css = readFileSync(
    new URL("../../../src/browser/styles/globals.css", import.meta.url),
    "utf8"
  );
  writeFileSync(sourcePath, css);
  expect(() => ensureTheme({ sourcePath, outputPath, check: true })).toThrow(/stale/);
  ensureTheme({ sourcePath, outputPath, check: false });
  const original = readFileSync(outputPath, "utf8");
  const modified = statSync(outputPath).mtimeMs;
  ensureTheme({ sourcePath, outputPath, check: false });
  expect(statSync(outputPath).mtimeMs).toBe(modified);
  ensureTheme({ sourcePath, outputPath, check: true });
  writeFileSync(
    sourcePath,
    css.replace(/--color-exec-mode:\s*[^;]+;/, "--color-exec-mode: #abcdef;")
  );
  expect(() => ensureTheme({ sourcePath, outputPath, check: true })).toThrow(/stale/);
  expect(readFileSync(outputPath, "utf8")).toBe(original);
  ensureTheme({ sourcePath, outputPath, check: false });
  expect(readFileSync(outputPath, "utf8")).not.toBe(original);
});
