import type { CSSProperties, ReactNode } from "react";
import React, { useContext, useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";
import { StreamingContext } from "./StreamingContext";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { isDesktopViewportFocused } from "@/browser/utils/ui/keybinds";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { transcriptMermaidSources } from "@/browser/utils/messages/transcriptQuoteAttributes";

const MIN_HEIGHT = 300;
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  layout: "elk",
  // Security hardening: Mermaid content is untrusted (comes from markdown),
  // so keep Mermaid's strict sanitization and disallow scriptable links.
  securityLevel: "strict",
  fontFamily: "var(--font-monospace)",
  darkMode: true,
  elk: {
    nodePlacementStrategy: "LINEAR_SEGMENTS",
    mergeEdges: true,
  },
  wrap: true,
  markdownAutoWrap: true,
  flowchart: {
    nodeSpacing: 60,
    curve: "linear",
    defaultRenderer: "elk",
  },
});

function decodeNumericCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    // Treat invalid numeric entities as empty content to avoid parser crashes
    // and collapse obfuscated scheme separators.
    return "";
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function decodeEntity(entityBody: string): string | null {
  if (entityBody.startsWith("#x") || entityBody.startsWith("#X")) {
    const parsed = Number.parseInt(entityBody.slice(2), 16);
    return Number.isNaN(parsed) ? "" : decodeNumericCodePoint(parsed);
  }

  if (entityBody.startsWith("#")) {
    const parsed = Number.parseInt(entityBody.slice(1), 10);
    return Number.isNaN(parsed) ? "" : decodeNumericCodePoint(parsed);
  }

  const named: Record<string, string> = {
    tab: "\t",
    newline: "\n",
    colon: ":",
    nbsp: " ",
  };

  return named[entityBody.toLowerCase()] ?? null;
}

function canonicalizeUrlForSchemeCheck(value: string): string {
  // Normalize encoded and obfuscated schemes before comparison so payloads like
  // java&#10;script:, java%0Ascript:, or java\nscript: reduce to javascript:.
  let normalized = value.toLowerCase();

  normalized = normalized.replace(/&([^;\s]+);?/g, (fullMatch, entityBody: string) => {
    return decodeEntity(entityBody) ?? fullMatch;
  });

  normalized = normalized.replace(/%([0-9a-f]{2})/gi, (fullMatch, hex: string) => {
    const parsed = Number.parseInt(hex, 16);
    return Number.isNaN(parsed) ? fullMatch : String.fromCodePoint(parsed);
  });

  let canonical = "";
  for (const char of normalized) {
    const charCode = char.charCodeAt(0);
    const isAsciiControl = charCode <= 0x1f || charCode === 0x7f;
    if (isAsciiControl || /\s/.test(char)) {
      continue;
    }

    canonical += char;
  }

  return canonical;
}

export function sanitizeMermaidSvg(svg: string): string | null {
  // Validate the SVG structure strictly so genuinely malformed input still
  // fails closed. The complication: Mermaid embeds HTML labels inside
  // <foreignObject> (wrap/markdownAutoWrap), and that HTML legitimately uses
  // void elements like bare <br>. Strict image/svg+xml DOMParser rejects such
  // SVG with a parsererror, which used to make every wrapped-label diagram
  // surface as "Mermaid returned invalid SVG output".
  //
  // Approach:
  //   1. Try strict XML parsing on the original. If it succeeds, the input is
  //      well-formed SVG; we're done.
  //   2. Otherwise, replace each <foreignObject>...</foreignObject> subtree
  //      with a self-closed placeholder and re-parse strictly. If that
  //      succeeds, the *only* XML invalidity lives inside foreignObject HTML
  //      (the known idiom we want to tolerate); we then materialize the
  //      original via the HTML parser, which handles SVG-plus-embedded-HTML
  //      the same way the browser does when innerHTML'd at the render sink.
  //   3. If stripping foreignObject doesn't make the outer structure parse,
  //      the malformed input is outside the wrapped-label case — reject it.
  //
  // This keeps the original "reject malformed SVG" contract intact while
  // accepting Mermaid's legitimate output.
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(svg, "image/svg+xml");
  const xmlHasError = xmlDoc.querySelector("parsererror") !== null;

  let svgRoot: Element | null;
  if (!xmlHasError) {
    svgRoot =
      xmlDoc.documentElement.tagName.toLowerCase() === "svg" ? xmlDoc.documentElement : null;
  } else {
    // Strip foreignObject subtrees and validate the outer structure strictly.
    // Non-greedy match; Mermaid does not nest foreignObject, and over-stripping
    // would only cause us to reject more aggressively (acceptable for a
    // validation step).
    const strippedForValidation = svg.replace(
      /<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi,
      "<foreignObject/>"
    );
    if (strippedForValidation === svg) {
      // No foreignObject in the input, so the XML error isn't the known idiom.
      return null;
    }
    const revalidated = parser.parseFromString(strippedForValidation, "image/svg+xml");
    if (revalidated.querySelector("parsererror") !== null) {
      // Outer structure is still malformed — fail closed.
      return null;
    }
    if (revalidated.documentElement.tagName.toLowerCase() !== "svg") {
      return null;
    }
    // Outer SVG is well-formed XML; only foreignObject HTML was problematic.
    // Materialize the original tree via the HTML parser so embedded labels
    // survive intact.
    const htmlDoc = parser.parseFromString(svg, "text/html");
    svgRoot = htmlDoc.querySelector("svg");
  }

  if (!svgRoot) {
    return null;
  }

  // Defense in depth: remove active content containers and sanitize remaining attributes.
  // NOTE: Keep <foreignObject> because Mermaid uses it for wrapped node labels.
  svgRoot.querySelectorAll("script,iframe,object,embed").forEach((node) => {
    node.remove();
  });

  const urlAttributes = new Set(["href", "xlink:href", "src", "action", "formaction"]);
  const blockedSchemes = ["javascript:", "vbscript:", "data:text/html"];

  const elementsToScan: Element[] = [svgRoot, ...Array.from(svgRoot.querySelectorAll("*"))];
  elementsToScan.forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const canonicalUrlValue = canonicalizeUrlForSchemeCheck(attribute.value.trim());

      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        urlAttributes.has(attributeName) &&
        blockedSchemes.some((scheme) => canonicalUrlValue.startsWith(scheme))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  return svgRoot.outerHTML;
}

function normalizeDiagramZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_ZOOM;
  }

  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

// Common button styles
const getButtonStyle = (disabled = false): CSSProperties => ({
  background: disabled ? "rgba(255, 255, 255, 0.05)" : "rgba(255, 255, 255, 0.1)",
  border: "1px solid rgba(255, 255, 255, 0.2)",
  color: disabled ? "var(--color-text-secondary)" : "var(--color-text)",
  padding: "6px 10px",
  cursor: disabled ? "not-allowed" : "pointer",
  borderRadius: "4px",
  fontSize: "16px",
  lineHeight: 1,
  opacity: disabled ? 0.5 : 1,
});

// Modal component for fullscreen diagram view
const DiagramModal: React.FC<{ children: ReactNode; onClose: () => void }> = ({
  children,
  onClose,
}) => {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleEscape, { capture: true });
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.9)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: "relative",
          maxWidth: "90%",
          maxHeight: "90%",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            background: "rgba(255, 255, 255, 0.1)",
            border: "1px solid rgba(255, 255, 255, 0.2)",
            color: "var(--color-text)",
            padding: "8px 16px",
            cursor: "pointer",
            borderRadius: "4px",
            fontSize: "14px",
            fontFamily: "var(--font-primary)",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

// Mermaid diagram component
export const Mermaid: React.FC<{ chart: string }> = ({ chart }) => {
  const { isStreaming } = useContext(StreamingContext);
  const modalContainerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [svg, setSvg] = useState<string>("");
  const lastValidSvgRef = useRef<string>("");
  const stableId = useId();

  // Debounce chart changes to avoid flickering during streaming
  const [debouncedChart, setDebouncedChart] = useState(chart);
  useEffect(() => {
    // Clear stale errors when chart changes - avoids error flash at end of stream
    setError(null);
    const timer = setTimeout(() => setDebouncedChart(chart), 350);
    return () => clearTimeout(timer);
  }, [chart]);

  const [storedDiagramZoom, setStoredDiagramZoom] = usePersistedState(
    "mermaid-diagram-zoom",
    DEFAULT_ZOOM,
    { listener: true }
  );
  // The +/- controls are shown as zoom affordances, so scale the rendered SVG
  // itself; changing only max-height is a no-op for diagrams already below the cap.
  const diagramZoom = normalizeDiagramZoom(storedDiagramZoom);
  const atMinZoom = diagramZoom <= MIN_ZOOM;
  const atMaxZoom = diagramZoom >= MAX_ZOOM;

  const handleZoomIn = () => {
    if (!atMaxZoom) {
      setStoredDiagramZoom((prev) => normalizeDiagramZoom(normalizeDiagramZoom(prev) + ZOOM_STEP));
    }
  };

  const handleZoomOut = () => {
    if (!atMinZoom) {
      setStoredDiagramZoom((prev) => normalizeDiagramZoom(normalizeDiagramZoom(prev) - ZOOM_STEP));
    }
  };

  useEffect(() => {
    // Use stable ID to avoid ELK layout recalculating from scratch each render
    const id = `mermaid-${stableId.replace(/:/g, "")}`;
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        // Parse first to validate syntax without rendering
        await mermaid.parse(debouncedChart);

        // If parse succeeds, render the diagram
        const { svg: renderedSvg } = await mermaid.render(id, debouncedChart);
        if (cancelled) return;

        const sanitizedSvg = sanitizeMermaidSvg(renderedSvg);
        if (!sanitizedSvg) {
          throw new Error("Mermaid returned invalid SVG output");
        }

        lastValidSvgRef.current = sanitizedSvg;
        setSvg(sanitizedSvg);
        setError(null);
      } catch (err) {
        if (cancelled) return;

        // Don't remove elements by ID - with stable IDs, we'd remove the last valid render
        // Mermaid error artifacts are cleaned up by subsequent successful renders

        setError(err instanceof Error ? err.message : "Failed to render diagram");
        // Don't clear SVG - keep showing last valid render during errors
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [debouncedChart, stableId]);

  // Update modal container when opened
  useEffect(() => {
    if (isModalOpen && modalContainerRef.current && svg) {
      // SECURITY AUDIT: svg state only stores sanitizeMermaidSvg() output.
      modalContainerRef.current.innerHTML = svg;
    }
  }, [isModalOpen, svg]);

  if (error && !isStreaming) {
    return (
      <pre
        style={{
          color: "var(--color-syntax-error)",
          background: "hsl(from var(--color-syntax-error) h s l / 0.1)",
          padding: "12px",
        }}
      >
        Mermaid Error: {error}
      </pre>
    );
  }

  // Keep one stable diagram frame while streaming or while the async Mermaid render is pending.
  // When no SVG has rendered yet, reserve the normal minimum diagram height so the transcript
  // doesn't expand from a short placeholder to a full diagram after debounce/parse/render.
  const displaySvg = svg || (isStreaming ? lastValidSvgRef.current : "");
  const showPendingPlaceholder = !displaySvg;

  return (
    <>
      <div
        style={{
          position: "relative",
          margin: "1em 0",
          background: "var(--color-code-bg)",
          borderRadius: "4px",
          padding: "16px",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            display: "flex",
            gap: "4px",
          }}
        >
          <TooltipIfPresent tooltip="Zoom out diagram" side="bottom">
            <button onClick={handleZoomOut} disabled={atMinZoom} style={getButtonStyle(atMinZoom)}>
              −
            </button>
          </TooltipIfPresent>
          <TooltipIfPresent tooltip="Zoom in diagram" side="bottom">
            <button onClick={handleZoomIn} disabled={atMaxZoom} style={getButtonStyle(atMaxZoom)}>
              +
            </button>
          </TooltipIfPresent>
          <TooltipIfPresent tooltip="Expand diagram" side="bottom">
            <button onClick={() => setIsModalOpen(true)} style={getButtonStyle()}>
              ⤢
            </button>
          </TooltipIfPresent>
        </div>
        <div
          className="mermaid-container"
          ref={(element) => {
            if (element) transcriptMermaidSources.set(element, chart);
          }}
          style={{
            maxWidth: "70%",
            margin: "0 auto",
            ["--diagram-zoom" as string]: `${diagramZoom}`,
            minHeight: `${MIN_HEIGHT}px`,
            ...(showPendingPlaceholder
              ? {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-text-secondary)",
                  fontStyle: "italic",
                }
              : {}),
          }}
          // SECURITY AUDIT: displaySvg is produced by sanitizeMermaidSvg(), which strips
          // active SVG/HTML content before insertion. React children are used for the
          // pending placeholder so untrusted chart text is never rendered as HTML.
          {...(!showPendingPlaceholder ? { dangerouslySetInnerHTML: { __html: displaySvg } } : {})}
        >
          {showPendingPlaceholder ? "Rendering diagram..." : null}
        </div>
      </div>
      {isModalOpen && (
        <DiagramModal onClose={() => setIsModalOpen(false)}>
          <div
            ref={modalContainerRef}
            className="mermaid-container mermaid-modal"
            style={{
              background: "var(--color-code-bg)",
              padding: "24px",
              borderRadius: "8px",
              minWidth: "80vw",
              minHeight: "60vh",
            }}
          />
        </DiagramModal>
      )}
    </>
  );
};
