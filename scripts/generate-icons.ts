#!/usr/bin/env bun
/**
 * Icon generation script for xum.
 *
 * Usage:
 *   bun scripts/generate-icons.ts [commands...]
 *
 * Commands:
 *   update           - Regenerate all logo sources and derived assets
 *   png              - Generate build/icon.png (512x512)
 *   icns             - Generate build/icon.icns (macOS app icon)
 *   linux-icons      - Generate build/icons/{16x16..512x512}.png (Linux icon set)
 *
 * If no command is given, defaults to: png icns
 */
import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  renderAppWordmark,
  renderDocsWordmark,
  renderInlineAppWordmark,
  renderSquareLogo,
} from "./logoAssets";

const ICONSET_SIZES = [16, 32, 64, 128, 256, 512];
const FAVICON_SIZES = [16, 32, 48, 64, 128, 256];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Source logos
const SOURCE_BLACK = path.join(ROOT, "docs", "img", "logo-black.svg");
const SOURCE_WHITE = path.join(ROOT, "docs", "img", "logo-white.svg");

const WORDMARK_TARGETS = {
  "docs/img/black-xum.svg": renderDocsWordmark("black"),
  "docs/img/white-xum.svg": renderDocsWordmark("white"),
  "src/browser/assets/logos/xum-logo-dark.svg": renderAppWordmark("white"),
  "src/browser/assets/logos/xum-logo-light.svg": renderAppWordmark("black"),
} as const;

const INLINE_WORDMARK_TARGETS = {
  "index.html": "boot-loader__logo",
  "static/splash.html": "logo",
} as const;

// Build outputs
const BUILD_DIR = path.join(ROOT, "build");
const ICONSET_DIR = path.join(BUILD_DIR, "icon.iconset");
const PNG_OUTPUT = path.join(BUILD_DIR, "icon.png");
const ICNS_OUTPUT = path.join(BUILD_DIR, "icon.icns");
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const;
const LINUX_ICON_DIR = path.join(BUILD_DIR, "icons");
const FAVICON_OUTPUT = path.join(ROOT, "public", "favicon.ico");
const FAVICON_DARK_OUTPUT = path.join(ROOT, "public", "favicon-dark.ico");

const THEME_FAVICON_STYLE = `<style>
  :root {
    color: #000;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      color: #fff;
    }
  }
</style>`;

type RasterTargetConfig = {
  /** Square side length, or [width, height] for non-square (e.g. wide tray icons). */
  size: number | [number, number];
  source: string;
  bg: boolean;
  format?: "png" | "webp";
  /** Override the SVG viewBox before rendering to crop tightly around content. */
  cropViewBox?: string;
};

type SvgTargetConfig = {
  svg: true;
  source: string;
};

type LogoTargetConfig = RasterTargetConfig | SvgTargetConfig;

// Keep the source + background pairing centralized so targets stay DRY.
const MONO_ICON = { source: SOURCE_BLACK, bg: false } as const;
const APP_ICON = { source: SOURCE_WHITE, bg: true } as const;

// Crop the centered square source to the restored m-block bounds so the mark
// fills small tray images without clipping the glyph or cursor.
// Content bounds: x 8.85…63.15, y 24.5…47.5 → 54.3×23 units. Keep roughly
// half a source unit of breathing room around the 2.33:1 mark.
const TRAY_MARK_CROP = "8 24 56 24";

// Targets to update (path -> config)
const LOGO_TARGETS = {
  // VS Code extension (Black on Transparent)
  "vscode/icon.png": { size: 128, ...MONO_ICON },

  // Browser asset (Vector)
  "src/browser/assets/icons/xum.svg": { svg: true, source: SOURCE_BLACK },

  // Docs (docs.json points at logo-black/logo-white directly to avoid duplicates)
  "docs/img/logo.webp": { size: 512, ...MONO_ICON, format: "webp" },

  // PWA / Public Icons (White on Black Background for visibility)
  "public/icon.png": { size: 512, ...APP_ICON },
  "public/icon-192.png": { size: 192, ...APP_ICON },
  "public/icon-512.png": { size: 512, ...APP_ICON },

  // iOS Safari uses apple-touch-icon for home screen installs.
  "public/apple-touch-icon.png": { size: 180, ...APP_ICON },

  // Electron Tray Icons – Wide m-Block Mark (Monochrome on Transparent)
  //
  // The restored mark is much wider than it is tall, so crop its internal
  // source padding before rendering to fill the output without clipping.
  //
  // Pixel dimensions: 24×24 @1x → 48×48 @2x → 72×72 @3x.
  // Square canvas; the mark (aspect ≈ 2.33:1) is height-constrained and
  // centered horizontally with transparent side padding.
  //
  // macOS treats the black variant as a template image (adapts to light/dark
  // menu bar automatically). Windows/Linux switch between black/white at
  // runtime based on the OS theme.
  "public/tray-icon-black.png": { size: 24, ...MONO_ICON, cropViewBox: TRAY_MARK_CROP },
  "public/tray-icon-black@2x.png": { size: 48, ...MONO_ICON, cropViewBox: TRAY_MARK_CROP },
  "public/tray-icon-black@3x.png": { size: 72, ...MONO_ICON, cropViewBox: TRAY_MARK_CROP },
  "public/tray-icon-white.png": {
    size: 24,
    source: SOURCE_WHITE,
    bg: false,
    cropViewBox: TRAY_MARK_CROP,
  },
  "public/tray-icon-white@2x.png": {
    size: 48,
    source: SOURCE_WHITE,
    bg: false,
    cropViewBox: TRAY_MARK_CROP,
  },
  "public/tray-icon-white@3x.png": {
    size: 72,
    source: SOURCE_WHITE,
    bg: false,
    cropViewBox: TRAY_MARK_CROP,
  },
} satisfies Record<string, LogoTargetConfig>;

const APP_ICON_PADDING_RATIO = 0.2;

async function generateRasterIcon({
  source,
  size,
  bg,
  format = "png",
  cropViewBox,
}: RasterTargetConfig) {
  const [w, h] = Array.isArray(size) ? size : [size, size];

  // If cropViewBox is set, read the SVG and override its viewBox so the
  // content fills the render canvas instead of being letter-boxed inside
  // the original (padded) viewBox.
  let input: string | Buffer = source;
  if (cropViewBox) {
    const svg = await readFile(source, "utf8");
    input = Buffer.from(svg.replace(/viewBox="[^"]*"/, `viewBox="${cropViewBox}"`));
  }

  let pipeline;

  if (!bg) {
    // Monochrome on transparent – fit the SVG content within the target
    // dimensions, preserving aspect ratio and centering with alpha padding.
    pipeline = sharp(input).resize(w, h, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  } else {
    // White on Black composite (app icons only – always square)
    const padding = Math.round(w * APP_ICON_PADDING_RATIO);
    const logoSize = w - padding * 2;

    pipeline = sharp({
      create: {
        width: w,
        height: h,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    }).composite([
      {
        input: await sharp(source).resize(logoSize, logoSize, { fit: "contain" }).toBuffer(),
        gravity: "center",
      },
    ]);
  }

  return format === "webp" ? pipeline.webp() : pipeline.png();
}

async function generateFavicon(source: string, output: string) {
  // Favicon uses Black on Transparent
  // Use ImageMagick if available for proper multi-resolution ICO
  try {
    const proc = Bun.spawn(
      [
        "magick",
        source,
        "-background",
        "none",
        "-resize",
        "256x256",
        "-define",
        `icon:auto-resize=${FAVICON_SIZES.join(",")}`,
        output,
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    const status = await proc.exited;
    if (status === 0) return;
  } catch {
    // ImageMagick not available
  }

  // Fallback: just use the 256x256 PNG renamed as ICO
  const pngBuffer = await sharp(source).resize(256, 256).png().toBuffer();
  await writeFile(output, pngBuffer);
  console.warn("  ⚠ ImageMagick not found, favicon.ico is single-resolution");
}

async function generateThemeFaviconSvg(output: string) {
  const svg = await readFile(SOURCE_BLACK, "utf8");
  const withCurrentColor = svg.replace(/fill="(black|white)"/g, 'fill="currentColor"');
  const themedSvg = withCurrentColor.replace(
    /<svg[^>]*>/,
    (match) => `${match}\n${THEME_FAVICON_STYLE}`
  );
  await writeFile(output, themedSvg);
}

async function replaceInlineWordmark(relativePath: string, className: string) {
  const outputPath = path.join(ROOT, relativePath);
  const html = await readFile(outputPath, "utf8");
  const pattern = new RegExp(
    String.raw`^([ \t]*)<svg class="${className}"[\s\S]*?^[ \t]*</svg>`,
    "m"
  );
  const match = html.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${className} logo in ${relativePath}`);
  }

  const indent = match[1];
  const svg = renderInlineAppWordmark(className)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
  await writeFile(outputPath, html.replace(pattern, svg));
}

async function generateSourceLogos() {
  await writeFile(SOURCE_BLACK, renderSquareLogo("black"));
  console.log("✓ docs/img/logo-black.svg");
  await writeFile(SOURCE_WHITE, renderSquareLogo("white"));
  console.log("✓ docs/img/logo-white.svg");

  for (const [relativePath, svg] of Object.entries(WORDMARK_TARGETS)) {
    await writeFile(path.join(ROOT, relativePath), svg);
    console.log(`✓ ${relativePath}`);
  }

  for (const [relativePath, className] of Object.entries(INLINE_WORDMARK_TARGETS)) {
    await replaceInlineWordmark(relativePath, className);
    console.log(`✓ ${relativePath}`);
  }
}

async function updateAllLogos() {
  console.log(`Updating all logos...\n`);

  await generateSourceLogos();

  for (const [relativePath, config] of Object.entries(LOGO_TARGETS)) {
    const outputPath = path.join(ROOT, relativePath);

    if ("svg" in config) {
      // For SVG target, just copy the source SVG (optimize/clean if needed, but direct copy is safe)
      await copyFile(config.source, outputPath);
    } else {
      const img = await generateRasterIcon(config);
      await img.toFile(outputPath);
    }
    console.log(`✓ ${relativePath}`);
  }

  const docsFaviconPath = path.join(ROOT, "docs", "favicon.svg");
  await generateThemeFaviconSvg(docsFaviconPath);
  console.log("✓ docs/favicon.svg");

  // Generate favicons (light/dark)
  await generateFavicon(MONO_ICON.source, FAVICON_OUTPUT);
  console.log(`✓ public/favicon.ico`);
  await generateFavicon(SOURCE_WHITE, FAVICON_DARK_OUTPUT);
  console.log(`✓ public/favicon-dark.ico`);

  console.log("\n✅ All logos updated successfully!");
}

async function generateBuildPng() {
  // Build PNG is App Icon (White on Black)
  const img = await generateRasterIcon({ size: 512, ...APP_ICON });
  await img.toFile(PNG_OUTPUT);
}

async function generateIconsetPngs() {
  await mkdir(ICONSET_DIR, { recursive: true });

  const tasks = ICONSET_SIZES.flatMap((size) => {
    const outputs = [
      {
        file: path.join(ICONSET_DIR, `icon_${size}x${size}.png`),
        dimension: size,
      },
    ];

    if (size <= 256) {
      const retina = size * 2;
      outputs.push({
        file: path.join(ICONSET_DIR, `icon_${size}x${size}@2x.png`),
        dimension: retina,
      });
    }

    return outputs.map(async ({ file, dimension }) => {
      const img = await generateRasterIcon({ size: dimension, ...APP_ICON });
      await img.toFile(file);
    });
  });

  await Promise.all(tasks);
}

async function generateIcns() {
  if (process.platform !== "darwin") {
    // Skip if not on mac
    console.warn("Skipping ICNS generation (requires macOS)");
    return;
  }

  const proc = Bun.spawn(["iconutil", "-c", "icns", ICONSET_DIR, "-o", ICNS_OUTPUT]);
  const status = await proc.exited;
  if (status !== 0) {
    throw new Error("iconutil failed to generate .icns file");
  }
}

async function generateLinuxIcons() {
  await rm(LINUX_ICON_DIR, { recursive: true, force: true });
  await mkdir(LINUX_ICON_DIR, { recursive: true });

  await Promise.all(
    LINUX_ICON_SIZES.map(async (size) => {
      const img = await generateRasterIcon({ size, ...APP_ICON });
      await img.toFile(path.join(LINUX_ICON_DIR, `${size}x${size}.png`));
    })
  );
}

// Parse arguments
const commands = new Set(process.argv.slice(2));

// Default to png + icns if no commands
if (commands.size === 0) {
  commands.add("png");
  commands.add("icns");
}

if (commands.has("update")) {
  await updateAllLogos();
}

if (commands.has("linux-icons")) {
  await mkdir(BUILD_DIR, { recursive: true });
  await generateLinuxIcons();
}

// Build commands
if (commands.has("png") || commands.has("icns")) {
  await mkdir(BUILD_DIR, { recursive: true });

  if (commands.has("png")) {
    await generateBuildPng();
  }

  if (commands.has("icns")) {
    await generateIconsetPngs();
    try {
      await generateIcns();
    } catch (e) {
      console.warn("Failed to generate ICNS:", e);
    }
  }

  await rm(ICONSET_DIR, { recursive: true, force: true });
}
