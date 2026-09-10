import type { z } from "zod";
import type { DesktopViewerEventSchema } from "@/common/orpc/schemas/api";

export type DesktopViewerEvent = z.infer<typeof DesktopViewerEventSchema>;

/**
 * Shared types for PortableDesktop integration.
 * Used by backend services and (future) oRPC routes.
 */

/** Machine-level prerequisite check result for PortableDesktop support. */
export type DesktopPrereqStatus =
  | { available: true }
  | {
      available: false;
      reason: "unsupported_platform" | "startup_failed" | "binary_not_found";
    };

/** Capability check result for a workspace's desktop support. */
export type DesktopCapability =
  | {
      available: true;
      width: number;
      height: number;
      sessionId: string;
      sharedDesktop?: { ownerWorkspaceId: string; ownerName: string };
    }
  | {
      available: false;
      reason:
        | "disabled"
        | "unsupported_platform"
        | "unsupported_runtime"
        | "startup_failed"
        | "binary_not_found";
    };

/** Actions the desktop can perform. */
export type DesktopActionType =
  | "click"
  | "double_click"
  | "right_click"
  | "move_mouse"
  | "drag"
  | "type_text"
  | "key_press"
  | "scroll";

/** Result of a desktop screenshot operation. */
export interface DesktopScreenshotResult {
  /** Base64-encoded PNG image data. */
  imageBase64: string;
  /** MIME type of the image (always "image/png" for now). */
  mimeType: "image/png";
  /** Width of the captured image in pixels. */
  width: number;
  /** Height of the captured image in pixels. */
  height: number;
}

/** Result of a desktop action operation. */
export interface DesktopActionResult {
  success: boolean;
  /** Error message when success is false. */
  error?: string;
}
