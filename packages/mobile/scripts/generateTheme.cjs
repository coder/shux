const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const postcss = require("postcss");

// CSS owns every hue. These opacity levels describe mobile surface treatments,
// so changing an accent in the canonical theme also changes its translucent surface.
const mobileTokens = {
  background: "--color-background",
  panel: "--color-surface-tertiary",
  elevated: "--color-bg-subtle",
  border: "--color-border-medium",
  text: "--color-lighter",
  bright: "--color-content-primary",
  muted: "--color-content-secondary",
  dim: "--color-dim",
  sheet: "--color-darker",
  selection: "--color-plan-mode-light",
  accent: "--color-exec-mode",
  accentSurface: { token: "--color-exec-mode", alpha: 0.12 },
  plan: "--color-plan-mode-light",
  danger: "--color-danger-light",
  dangerSurface: { token: "--color-danger-light", alpha: 0.1 },
  warning: "--color-edit-mode-light",
  warningSurface: { token: "--color-edit-mode-light", alpha: 0.1 },
  success: "--color-content-success",
  user: "--color-user-surface",
  scrim: "--color-overlay-scrim",
};

/** @param {string} value @param {number} maximum */
function channel(value, maximum) {
  assert(/^[+-]?(?:\d+\.?\d*|\.\d+)%?$/.test(value), `Unsupported color channel: ${value}`);
  const number = Number.parseFloat(value) * (value.endsWith("%") ? maximum / 100 : 1);
  assert(number >= 0 && number <= maximum, `Color channel out of range: ${value}`);
  return number;
}

/** @param {string} value @returns {number[]} */
function rgba(value) {
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (hex) {
    const bytes = hex[1].length < 5 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return [0, 2, 4]
      .map((offset) => Number.parseInt(bytes.slice(offset, offset + 2), 16))
      .concat(bytes.length === 8 ? Number.parseInt(bytes.slice(6), 16) / 255 : 1);
  }
  const match = /^(hsla?|rgba?)\(([^()]*)\)$/i.exec(value);
  assert(match, `Unsupported native theme color: ${value}`);
  const body = match[2].trim();
  const parts = body.includes(",") ? body.split(/\s*,\s*/) : body.split(/\s*\/\s*/);
  const channels = body.includes(",") ? parts.slice(0, 3) : parts[0].split(/\s+/);
  const alpha = body.includes(",") ? parts[3] : parts[1];
  assert(
    channels.length === 3 && parts.length <= (body.includes(",") ? 4 : 2),
    `Unsupported color: ${value}`
  );
  let rgb;
  if (match[1].toLowerCase().startsWith("hsl")) {
    assert(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg)?$/.test(channels[0]), `Unsupported hue: ${value}`);
    assert(channels[1].endsWith("%") && channels[2].endsWith("%"), `Unsupported HSL: ${value}`);
    const degrees = Number.parseFloat(channels[0]);
    assert(Number.isFinite(degrees), `Unsupported hue: ${value}`);
    const hue = (((degrees % 360) + 360) % 360) / 30;
    const saturation = channel(channels[1], 100) / 100;
    const lightness = channel(channels[2], 100) / 100;
    const amplitude = saturation * Math.min(lightness, 1 - lightness);
    rgb = [0, 8, 4].map((offset) => {
      const k = (offset + hue) % 12;
      return 255 * (lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    });
  } else {
    rgb = channels.map((component) => channel(component, 255));
  }
  return [...rgb.map(Math.round), alpha === undefined ? 1 : channel(alpha, 1)];
}

/**
 * Only the canonical dark :root @theme participates, never platform/theme overrides.
 * @param {string} css
 * @param {Record<string, string | { token: string, alpha: number }>} [tokens]
 * @returns {Record<string, string>}
 */
function projectTheme(css, tokens = mobileTokens) {
  const themes = postcss
    .parse(css)
    .nodes.filter((node) => node.type === "rule" && node.selector === ":root")
    .flatMap((node) =>
      node.nodes.filter((child) => child.type === "atrule" && child.name === "theme")
    );
  assert(themes.length === 1, "Expected exactly one canonical :root @theme");
  const values = new Map(
    themes[0].nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value])
  );
  /** @param {string} token @param {Set<string>} [visiting] @returns {number[]} */
  function resolve(token, visiting = new Set()) {
    assert(!visiting.has(token), `Theme alias cycle: ${token}`);
    const value = values.get(token);
    assert(value !== undefined, `Missing theme token: ${token}`);
    const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
    return alias ? resolve(alias[1], new Set([...visiting, token])) : rgba(value.trim());
  }
  return Object.fromEntries(
    Object.entries(tokens).map(([key, entry]) => {
      const { token, alpha } =
        typeof entry === "string" ? { token: entry, alpha: undefined } : entry;
      const color = resolve(token);
      if (alpha !== undefined) color[3] = channel(String(alpha), 1);
      return [key, `rgba(${color.map((component) => Number(component.toFixed(6))).join(", ")})`];
    })
  );
}

/** @param {{ sourcePath?: string, outputPath?: string, check?: boolean }} [options] */
function ensureTheme(options = {}) {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const sourcePath =
    options.sourcePath ?? path.join(repositoryRoot, "src/browser/styles/globals.css");
  const outputPath =
    options.outputPath ??
    path.join(repositoryRoot, "src/common/constants/mobileThemeColors.generated.ts");
  const colors = projectTheme(readFileSync(sourcePath, "utf8"));
  const content =
    "// Generated from globals.css by packages/mobile/scripts/generateTheme.cjs.\n" +
    "// Run the generator with --write to refresh; do not edit this palette manually.\n" +
    "export const mobileThemeColors = {\n" +
    Object.entries(colors)
      .map(([key, color]) => `  ${key}: ${JSON.stringify(color)},\n`)
      .join("") +
    "} as const;\n";
  let current;
  try {
    current = readFileSync(outputPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current === content) return;
  assert(
    !(options.check ?? Boolean(process.env.CI)),
    "Native theme projection is stale; run node packages/mobile/scripts/generateTheme.cjs --write"
  );
  writeFileSync(outputPath, content);
}

module.exports = { projectTheme, ensureTheme };

if (require.main === module) {
  const mode = process.argv[2];
  assert(
    process.argv.length === 3 && ["--write", "--check"].includes(mode),
    "Usage: node packages/mobile/scripts/generateTheme.cjs --write|--check"
  );
  // CI must diagnose drift, never conceal it by regenerating the committed projection.
  ensureTheme({ check: Boolean(process.env.CI) || mode === "--check" });
}
