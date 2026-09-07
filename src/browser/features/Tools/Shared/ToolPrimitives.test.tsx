import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AlertTriangle,
  Globe,
  MessageCircleQuestion,
  Pencil,
  RefreshCw,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { TOOL_NAME_TO_ICON, ToolIcon } from "./ToolPrimitives";

function glyph(markup: string): string {
  const match = /<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(markup);
  expect(match).not.toBeNull();
  return match![1];
}

const cases: Array<[string, LucideIcon]> = [
  ["bash", Wrench],
  ["ask_user_question", MessageCircleQuestion],
  ["file_edit_insert", Pencil],
  ["server:GOOGLE_SEARCH_WEB", Globe],
  ["mcp__custom__search", Sparkles],
  ["unknown_tool", Sparkles],
  ["constructor", Sparkles],
  ["__proto__", Sparkles],
];

test.each(cases)("desktop tool %s preserves its actual SVG glyph", (toolName, Expected) => {
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <ToolIcon toolName={toolName} />
    </TooltipProvider>
  );
  expect(glyph(markup)).toBe(glyph(renderToStaticMarkup(<Expected />)));
});

test("desktop emoji overrides preserve normalization, fallback, and spin control", () => {
  for (const [emoji, Expected] of [
    ["⚠️", AlertTriangle],
    ["🔄", RefreshCw],
    ["unmapped", Sparkles],
  ] as const) {
    const renderIcon = (spin?: boolean) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <ToolIcon toolName="bash" emoji={emoji} emojiSpin={spin} />
        </TooltipProvider>
      );
    expect(glyph(renderIcon())).toBe(glyph(renderToStaticMarkup(<Expected />)));
    expect(renderIcon().includes("animate-spin")).toBe(emoji === "🔄");
    expect(renderIcon(false).includes("animate-spin")).toBe(false);
  }
});

test("generic desktop cards retain the exported named-tool component registry", () => {
  expect(TOOL_NAME_TO_ICON.file_edit_replace_string).toBe(Pencil);
  expect(TOOL_NAME_TO_ICON["server:GOOGLE_SEARCH_WEB"]).toBe(Globe);
  expect(Object.hasOwn(TOOL_NAME_TO_ICON, "unknown_tool")).toBe(false);
});
