import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { InitMessage } from "@/browser/features/Messages/InitMessage";
import type { DisplayedMessage } from "@/common/types/message";

type WorkspaceInitMessage = Extract<DisplayedMessage, { type: "workspace-init" }>;

// Stable timestamp inlined (the story imports STABLE_TIMESTAMP from mocks; the
// exact value is irrelevant — InitMessage only renders duration text from durationMs).
const INIT_SUCCESS_MESSAGE: WorkspaceInitMessage = {
  type: "workspace-init",
  id: "init-success",
  historySequence: 1,
  status: "success",
  hookPath: "/home/user/projects/my-app/.xum/init.sh",
  lines: [
    { line: "Installing dependencies...", isError: false },
    { line: "Setting up environment variables...", isError: false },
    { line: "Starting development server...", isError: false },
  ],
  exitCode: 0,
  timestamp: 1_699_999_894_000,
  durationMs: 3000,
};

const INIT_ERROR_MESSAGE: WorkspaceInitMessage = {
  type: "workspace-init",
  id: "init-error",
  historySequence: 1,
  status: "error",
  hookPath: "/home/user/projects/my-app/.xum/init.sh",
  lines: [
    { line: "Installing dependencies...", isError: false },
    { line: "Failed to install package 'missing-dep'", isError: true },
    { line: "npm ERR! code E404", isError: true },
  ],
  exitCode: 1,
  timestamp: 1_699_999_893_000,
  durationMs: 3000,
};

export const InitHookSuccess = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        <InitMessage message={INIT_SUCCESS_MESSAGE} />
      </div>
    </div>
  </MuxPreviewShell>
);

export const InitHookError = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        <InitMessage message={INIT_ERROR_MESSAGE} />
      </div>
    </div>
  </MuxPreviewShell>
);
