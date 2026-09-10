import React, { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import { useAPI } from "@/browser/contexts/API";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { downloadBlob } from "@/browser/utils/downloadFile";
import { getErrorMessage } from "@/common/utils/errors";

const JsonOutput: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bg-code-bg text-text mt-3 w-full max-w-full min-w-0 overflow-x-auto rounded-sm">
    <pre className="min-w-max p-3 font-mono text-xs leading-relaxed whitespace-pre">{children}</pre>
  </div>
);

interface DebugLlmRequestModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DebugLlmRequestModal: React.FC<DebugLlmRequestModalProps> = ({
  workspaceId,
  open,
  onOpenChange,
}) => {
  const { api } = useAPI();
  const { copied, copyToClipboard: copy } = useCopyToClipboard(copyToClipboard);

  const [snapshot, setSnapshot] = useState<DebugLlmRequestSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSnapshot = useCallback(async () => {
    if (!api) return;

    setLoading(true);
    setError(null);

    try {
      const result = await api.workspace.getLastLlmRequest({ workspaceId });
      if (!result.success) {
        setError(result.error);
        setSnapshot(null);
        return;
      }

      setSnapshot(result.data);
    } catch (err) {
      setError(getErrorMessage(err));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    if (!open || !api) return;
    void fetchSnapshot();
  }, [open, api, fetchSnapshot]);

  const json = snapshot ? JSON.stringify(snapshot, null, 2) : "";
  const capturedAtLabel = snapshot ? new Date(snapshot.capturedAt).toLocaleString() : null;

  const handleDownload = () => {
    if (!snapshot) return;
    const timestamp = new Date(snapshot.capturedAt).toISOString().replace(/[:.]/g, "-");
    const fileName = `xum-llm-request-${workspaceId}-${timestamp}.json`;
    void downloadBlob(new Blob([json], { type: "application/json" }), fileName);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent maxWidth="900px" maxHeight="85vh" className="min-w-0 gap-5 overflow-x-hidden">
        <DialogHeader className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <DialogTitle>Last LLM request</DialogTitle>
              <div className="text-muted text-xs">
                Captures the exact payload sent to the provider for this workspace.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchSnapshot()}
                disabled={!api || loading}
              >
                {loading ? "Loading..." : "Refresh"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copy(json)}
                disabled={!snapshot || loading}
              >
                {copied ? "Copied" : "Copy JSON"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDownload}
                disabled={!snapshot || loading}
              >
                <Download className="size-3.5" />
                Download
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          {error && <div className="text-danger-soft text-sm">{error}</div>}

          {loading && !snapshot && (
            <div className="text-muted text-sm">Loading last request...</div>
          )}

          {!loading && !error && !snapshot && (
            <div className="text-muted text-sm">
              No request captured yet. Send a message, then open this modal again.
            </div>
          )}

          {snapshot && (
            <div className="min-w-0 space-y-4">
              <div className="border-border-light bg-foreground/5 rounded-md border p-3 text-xs">
                <div className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground font-mono">{snapshot.providerName}</span>
                  <span>•</span>
                  <span className="text-foreground font-mono">{snapshot.model}</span>
                  <span>•</span>
                  <span className="text-foreground font-mono">
                    thinking={snapshot.thinkingLevel}
                  </span>
                  {snapshot.mode && (
                    <>
                      <span>•</span>
                      <span className="text-foreground font-mono">mode={snapshot.mode}</span>
                    </>
                  )}
                  {snapshot.agentId && (
                    <>
                      <span>•</span>
                      <span className="text-foreground font-mono">agent={snapshot.agentId}</span>
                    </>
                  )}
                  {snapshot.maxOutputTokens && (
                    <>
                      <span>•</span>
                      <span className="text-foreground font-mono">
                        maxTokens={snapshot.maxOutputTokens}
                      </span>
                    </>
                  )}
                </div>
                {capturedAtLabel && (
                  <div className="text-muted mt-2 text-[11px]">Captured {capturedAtLabel}</div>
                )}
              </div>

              <div className="min-w-0 space-y-3">
                <details
                  open
                  className="border-border-light bg-modal-bg min-w-0 rounded-md border p-3"
                >
                  <summary className="text-foreground cursor-pointer text-sm font-medium">
                    System message
                  </summary>
                  <pre className="bg-code-bg text-text mt-3 rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                    {snapshot.systemMessage}
                  </pre>
                </details>

                <details className="border-border-light bg-modal-bg min-w-0 rounded-md border p-3">
                  <summary className="text-foreground cursor-pointer text-sm font-medium">
                    Messages
                  </summary>
                  <JsonOutput>{JSON.stringify(snapshot.messages, null, 2)}</JsonOutput>
                </details>

                <details className="border-border-light bg-modal-bg min-w-0 rounded-md border p-3">
                  <summary className="text-foreground cursor-pointer text-sm font-medium">
                    Response
                  </summary>
                  {snapshot.response ? (
                    <JsonOutput>{JSON.stringify(snapshot.response, null, 2)}</JsonOutput>
                  ) : (
                    <div className="text-muted mt-3 text-xs">
                      No response captured yet (wait for the stream to finish).
                    </div>
                  )}
                </details>

                <details className="border-border-light bg-modal-bg min-w-0 rounded-md border p-3">
                  <summary className="text-foreground cursor-pointer text-sm font-medium">
                    Full JSON
                  </summary>
                  <JsonOutput>{json}</JsonOutput>
                </details>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
