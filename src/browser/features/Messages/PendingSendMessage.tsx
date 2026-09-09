import React from "react";
import { FileText, Loader2 } from "lucide-react";
import type { PendingSendMessage as PendingSendMessageData } from "@/common/types/message";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";

interface PendingSendMessageProps {
  message: PendingSendMessageData;
}

// Mirror the sent user bubble so the row stays in place when the persisted message replaces it.
export const PendingSendMessage: React.FC<PendingSendMessageProps> = (props) => {
  const stagingFilenames = props.message.stagingFilenames ?? [];
  return (
    <div
      className="mt-4 mb-1 ml-auto flex w-fit max-w-full flex-col"
      data-component="PendingSendMessage"
    >
      <div className="rounded-lg border border-[var(--color-user-border)] bg-[var(--color-user-surface)] px-3 py-2 shadow-sm">
        <UserMessageContent
          content={props.message.content}
          reviews={props.message.reviews}
          fileParts={props.message.fileParts}
          variant="sent"
        />
        {stagingFilenames.length > 0 && (
          // Inert on purpose: file bytes never reach the renderer as an openable URL.
          <div className="mt-3 flex flex-wrap gap-3">
            {stagingFilenames.map((filename) => (
              <span
                key={filename}
                className="flex max-w-80 items-center gap-2 rounded-xl border border-[var(--color-attachment-border)] px-3 py-2 text-sm text-[var(--color-subtle)] opacity-70"
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">{filename}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        role="status"
        className="text-muted mt-2 ml-auto flex items-center gap-1.5 text-[11px]"
        data-component="PendingSendStatus"
      >
        <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin" />
        <span>Sending...</span>
      </div>
    </div>
  );
};
