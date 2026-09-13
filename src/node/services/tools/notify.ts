/**
 * Notification tool - sends system notifications to the user
 *
 * This tool allows AI agents to notify users of important events using the
 * operating system's native notification system (macOS Notification Center,
 * Windows Toast notifications, Linux notification daemon).
 *
 * Uses Electron's cross-platform Notification API when available, with graceful
 * fallback for non-Electron environments. Clicking a notification navigates
 * the user to the workspace that sent it.
 */

import { tool } from "ai";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { NotifyToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";

/** Maximum notification body length (macOS limit is 256 bytes) */
const MAX_NOTIFICATION_BODY_LENGTH = 200;

/** Maximum notification title length */
const MAX_NOTIFICATION_TITLE_LENGTH = 64;

/**
 * Truncates text to a maximum length, adding ellipsis if truncated
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "…";
}

/**
 * Check if we're running in Electron environment
 */
function isElectronEnvironment(): boolean {
  return typeof process.versions.electron === "string";
}

/**
 * Send a system notification using Electron's Notification API.
 * When clicked, focuses the app and navigates to the specified workspace.
 * Returns true if notification was shown, false otherwise.
 */
async function sendElectronNotification(
  title: string,
  body?: string,
  workspaceId?: string
): Promise<{ success: boolean; error?: string }> {
  if (!isElectronEnvironment()) {
    return {
      success: false,
      error: "System notifications not supported (not running in Electron)",
    };
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- Electron is unavailable in `mux server`; avoid top-level import
    const { Notification, BrowserWindow } = await import("electron");

    if (!Notification.isSupported()) {
      return {
        success: false,
        error: "System notifications not supported on this platform",
      };
    }

    const notification = new Notification({
      title: truncateText(title, MAX_NOTIFICATION_TITLE_LENGTH),
      body: body ? truncateText(body, MAX_NOTIFICATION_BODY_LENGTH) : undefined,
      silent: false,
    });

    // Handle notification click - focus app and navigate to workspace
    notification.on("click", () => {
      const windows = BrowserWindow.getAllWindows();
      const mainWindow = windows[0];
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Restore if minimized, then focus
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();

        // Send IPC message to renderer to navigate to workspace
        if (workspaceId) {
          mainWindow.webContents.send("mux:notification-clicked", { workspaceId });
        }
      }
    });

    notification.show();

    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      success: false,
      error: `Failed to send notification: ${message}`,
    };
  }
}

/**
 * Notify tool factory for AI assistant
 * Creates a tool that sends system notifications to the user
 */
export const createNotifyTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.notify.description,
    inputSchema: TOOL_DEFINITIONS.notify.schema,
    execute: async ({ title, message }, options): Promise<NotifyToolResult> => {
      // Validate title
      if (!title || title.trim().length === 0) {
        return {
          success: false,
          error: "Notification title is required and cannot be empty",
        };
      }

      const trimmedTitle = title.trim();
      const trimmedMessage = message?.trim();

      const truncatedTitle = truncateText(trimmedTitle, MAX_NOTIFICATION_TITLE_LENGTH);
      const truncatedMessage = trimmedMessage
        ? truncateText(trimmedMessage, MAX_NOTIFICATION_BODY_LENGTH)
        : undefined;

      const result = await sendElectronNotification(
        truncatedTitle,
        truncatedMessage,
        config.workspaceId
      );

      if (config.workspaceId != null && config.timelineService != null) {
        config.timelineService.record(config.workspaceId, {
          kind: "agent.notified",
          source: { system: "agent", key: `notify:${options.toolCallId}` },
          anchor: { toolCallId: options.toolCallId },
          status: "completed",
          data: {
            title: truncatedTitle,
            ...(truncatedMessage != null ? { digest: truncatedMessage } : {}),
          },
        });
      }

      // If Electron notification succeeded, we're done
      if (result.success) {
        return {
          success: true,
          title: truncatedTitle,
          message: truncatedMessage,
          ui_only: {
            notify: {
              notifiedVia: "electron",
              workspaceId: config.workspaceId,
            },
          },
        };
      }

      // Electron unavailable - signal frontend to handle browser notification
      // This is not an error; the notification will be delivered via Web Notifications API
      return {
        success: true,
        title: truncatedTitle,
        message: truncatedMessage,
        ui_only: {
          notify: {
            notifiedVia: "browser",
            workspaceId: config.workspaceId,
          },
        },
      };
    },
  });
};
