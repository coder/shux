/**
 * Copy text to clipboard with fallback for environments without Clipboard API
 * @param text The text to copy
 * @returns Promise that resolves when copy succeeds
 */
export async function copyToClipboard(text: string): Promise<void> {
  // Try modern clipboard API first
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback for browsers without clipboard API (e.g., Storybook, HTTP contexts)
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export interface FormattedClipboardContent {
  text: string;
  html: string;
}

/** Copy Markdown and rich text together so formatted paste works in Slack. */
export async function copyFormattedToClipboard(content: FormattedClipboardContent): Promise<void> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([content.text], { type: "text/plain" }),
        "text/html": new Blob([content.html], { type: "text/html" }),
      }),
    ]);
    return;
  }

  await copyToClipboard(content.text);
}
