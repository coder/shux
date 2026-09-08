/**
 * Shared blob-download helper. iOS home-screen web apps have no download
 * manager: clicking an anchor with a `download` attribute silently aborts
 * (WebKit limitation), so downloads are offered through the native share
 * sheet ("Save Image" / "Save to Files") there.
 */

import { isIosStandaloneWebApp } from "@/browser/utils/env";

function canShareFile(file: File): boolean {
  return typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true;
}

/**
 * WebKit rejects share() with NotAllowedError when the gesture's transient
 * activation has expired (e.g. after a slow fetch); only that failure is
 * retryable with a fresh tap. Where the UA exposes userActivation, a
 * NotAllowedError with activation still live is a permanent denial (e.g.
 * permissions policy), not an expiry.
 */
function isTransientActivationExpiry(err: unknown): boolean {
  if (!(err instanceof DOMException) || err.name !== "NotAllowedError") return false;
  const activation = (navigator as Navigator & { userActivation?: { isActive?: boolean } })
    .userActivation;
  return activation?.isActive !== true;
}

/** Trigger a plain anchor download. Unusable in iOS standalone mode. */
export function downloadViaAnchor(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * "blocked" is retryable within a fresh user gesture; "unshareable" is
 * permanent for the file in the current environment.
 */
export type DownloadBlobResult = "delivered" | "blocked" | "unshareable";

/**
 * Trigger a download of a blob, using the share sheet on iOS home-screen web
 * apps. Runs synchronously up to the share-sheet call, so invoking it inside
 * a click handler keeps the share within the gesture's transient activation.
 *
 * Both failure branches alert the user here, at the shared boundary, so
 * fire-and-forget callers cannot silently drop a failed download; the result
 * exists for callers that manage retries (see createDownloadRetryCache).
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<DownloadBlobResult> {
  if (isIosStandaloneWebApp()) {
    const file = new File([blob], filename, { type: blob.type });
    if (!canShareFile(file)) {
      // Anchor downloads silently abort in iOS standalone mode, so there is
      // no usable fallback for unshareable files.
      window.alert(`This file type (${blob.type || "unknown"}) can't be saved from this app.`);
      return "unshareable";
    }
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      // AbortError means the user dismissed the share sheet.
      if (err instanceof DOMException && err.name === "AbortError") return "delivered";
      console.error("Failed to share file:", err);
      if (isTransientActivationExpiry(err)) {
        window.alert("Saving was interrupted. Tap the download again to save.");
        return "blocked";
      }
      window.alert("This file can't be saved from this app.");
      return "unshareable";
    }
    return "delivered";
  }

  const objectUrl = URL.createObjectURL(blob);
  downloadViaAnchor(objectUrl, filename);
  // Delay revocation so the browser can start the download first.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return "delivered";
}

interface FetchedFile {
  blob: Blob;
  filename: string;
}

/**
 * Download coordinator for flows that fetch a file's bytes asynchronously
 * after the user gesture. If the fetch outlives iOS's transient-activation
 * window, the share sheet is blocked; the fetched bytes are kept so the
 * user's retry tap shares synchronously within its own activation window
 * instead of repeating the fetch and failing again.
 *
 * Holds a single retry slot: only the most recent "blocked" download is
 * retained (a retry alert only ever refers to the last tap), so abandoned
 * retries are evicted by the next blocked download and retained memory is
 * bounded to one blob. Unshareable files can never succeed and are never
 * cached.
 */
export function createDownloadRetryCache() {
  let entry: { key: string; file: FetchedFile } | null = null;
  let latestCall = 0;
  return {
    /**
     * stillWanted is re-checked after the fetch resolves; callers should
     * return false once their originating context is gone (e.g. the user
     * navigated to another workspace) so a slow fetch cannot fire a share
     * sheet or alert about a context the user already left.
     */
    async download(
      key: string,
      fetchFile: () => Promise<FetchedFile | null>,
      stillWanted?: () => boolean
    ): Promise<void> {
      const call = ++latestCall;
      if (entry?.key === key) {
        if ((await downloadBlob(entry.file.blob, entry.file.filename)) !== "blocked") {
          entry = null;
        }
        return;
      }
      const fetched = await fetchFile();
      if (!fetched) {
        return;
      }
      // Only the iOS share-sheet path is side-effect sensitive: a fetch
      // superseded by a later tap or an abandoned context must not open the
      // sheet (hijacking the newer tap's activation) or alert without owning
      // the slot. Ordinary anchor downloads elsewhere are independent and
      // must all be delivered, even concurrently.
      if (isIosStandaloneWebApp() && (call !== latestCall || stillWanted?.() === false)) {
        return;
      }
      if ((await downloadBlob(fetched.blob, fetched.filename)) === "blocked") {
        entry = { key, file: fetched };
      }
    },
  };
}
