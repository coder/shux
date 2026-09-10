import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createDownloadRetryCache, downloadBlob } from "./downloadFile";
import { downloadDataUrl } from "./imageActions";

const PNG_DATA_URL = `data:image/png;base64,${btoa("x")}`;

interface AnchorStub {
  href: string;
  download: string;
  click: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
}

let originalNavigator: typeof globalThis.navigator;
let originalDocument: typeof globalThis.document;
let originalWindow: typeof globalThis.window;
let alertMock: ReturnType<typeof mock>;
let originalCreateObjectURL: typeof URL.createObjectURL;
let createObjectURLMock: ReturnType<typeof mock>;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;
let anchor: AnchorStub;
let createElement: ReturnType<typeof mock>;

function installNavigator(nav: {
  standalone?: boolean;
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[] }) => Promise<void>;
  userActivation?: { isActive: boolean };
}) {
  globalThis.navigator = nav as unknown as Navigator;
}

beforeEach(() => {
  originalNavigator = globalThis.navigator;
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  alertMock = mock(() => undefined);
  globalThis.window = { alert: alertMock } as unknown as Window & typeof globalThis;
  originalCreateObjectURL = URL.createObjectURL.bind(URL);
  originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  anchor = {
    href: "",
    download: "",
    click: mock(() => undefined),
    remove: mock(() => undefined),
  };
  createElement = mock(() => anchor);
  globalThis.document = {
    createElement,
    body: { appendChild: mock(() => undefined) },
  } as unknown as Document;
  createObjectURLMock = mock(() => "blob:test");
  URL.createObjectURL = createObjectURLMock;
  URL.revokeObjectURL = mock(() => undefined);
});

afterEach(() => {
  globalThis.navigator = originalNavigator;
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("downloadBlob", () => {
  it("routes through the share sheet in iOS home-screen web apps", async () => {
    const share = mock((_data: { files: File[] }) => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(
      "delivered"
    );

    expect(share).toHaveBeenCalledTimes(1);
    const [{ files }] = share.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("shot.png");
    expect(files[0].type).toBe("image/png");
    expect(createElement).not.toHaveBeenCalled();
  });

  it("treats a dismissed share sheet as delivered", async () => {
    const share = mock(() => Promise.reject(new DOMException("dismissed", "AbortError")));
    installNavigator({ standalone: true, canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(
      "delivered"
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
  });

  it("reports a blocked share sheet, alerting instead of falling back to an anchor", async () => {
    // WebKit rejects with NotAllowedError when transient activation expired.
    const share = mock(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    installNavigator({ standalone: true, canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe("blocked");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(createElement).not.toHaveBeenCalled();
  });

  it("treats NotAllowedError with live user activation as a permanent denial", async () => {
    const share = mock(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    installNavigator({
      standalone: true,
      canShare: () => true,
      share,
      userActivation: { isActive: true },
    });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(
      "unshareable"
    );
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("treats non-activation share rejections as permanent", async () => {
    const share = mock(() => Promise.reject(new TypeError("invalid share data")));
    installNavigator({ standalone: true, canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(
      "unshareable"
    );
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("uses an anchor download outside iOS standalone mode even when share is available", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(
      "delivered"
    );

    expect(share).not.toHaveBeenCalled();
    expect(anchor.href).toBe("blob:test");
    expect(anchor.download).toBe("shot.png");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("alerts and reports unshareable instead of an unusable anchor when iOS standalone cannot share the file", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => false, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(
      "unshareable"
    );

    expect(share).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(anchor.click).not.toHaveBeenCalled();
  });
});

describe("downloadDataUrl", () => {
  it("uses the data URL directly as anchor href outside iOS standalone, without decoding", () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ canShare: () => true, share });

    downloadDataUrl(PNG_DATA_URL, "shot.png");

    expect(share).not.toHaveBeenCalled();
    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(anchor.href).toBe(PNG_DATA_URL);
    expect(anchor.download).toBe("shot.png");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("decodes and shares in iOS standalone mode", () => {
    const share = mock((_data: { files: File[] }) => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });

    downloadDataUrl(PNG_DATA_URL, "shot.png");

    expect(share).toHaveBeenCalledTimes(1);
    expect(anchor.click).not.toHaveBeenCalled();
  });
});

describe("createDownloadRetryCache", () => {
  const fetchedFile = () => ({ blob: new Blob(["x"], { type: "image/png" }), filename: "a.png" });
  type FetchedFileForTest = ReturnType<typeof fetchedFile>;

  it("serves a retry from cache after a blocked share, then clears it once delivered", async () => {
    let shareCalls = 0;
    const share = mock(() => {
      shareCalls += 1;
      return shareCalls === 1
        ? Promise.reject(new DOMException("denied", "NotAllowedError"))
        : Promise.resolve();
    });
    installNavigator({ standalone: true, canShare: () => true, share });
    const fetchFile = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    // First tap: fetch runs, share is blocked, bytes get cached.
    await downloads.download("key", fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);

    // Retry tap: shares from cache without refetching.
    await downloads.download("key", fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(2);

    // Delivered, so the cache entry is gone and a new tap refetches.
    await downloads.download("key", fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("does not cache when the share succeeds immediately", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });
    const fetchFile = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    await downloads.download("key", fetchFile);
    await downloads.download("key", fetchFile);

    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("evicts an abandoned blocked entry when a different download gets blocked", async () => {
    const share = mock(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    installNavigator({ standalone: true, canShare: () => true, share });
    const fetchA = mock(() => Promise.resolve(fetchedFile()));
    const fetchB = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    await downloads.download("a", fetchA);
    await downloads.download("b", fetchB);

    // "b" now owns the single retry slot, so retrying "a" refetches.
    await downloads.download("a", fetchA);
    expect(fetchA).toHaveBeenCalledTimes(2);

    // "b" was evicted by the second blocked "a", so it refetches too.
    await downloads.download("b", fetchB);
    expect(fetchB).toHaveBeenCalledTimes(2);
  });

  it("ignores a slower earlier fetch that resolves after a later tap claimed the slot", async () => {
    const share = mock(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    installNavigator({ standalone: true, canShare: () => true, share });
    let resolveA: (file: FetchedFileForTest) => void = () => undefined;
    const fetchA = mock(() => new Promise<FetchedFileForTest>((resolve) => (resolveA = resolve)));
    const fetchB = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    // Tap A (fetch hangs), then tap B (blocked, claims the slot).
    const pendingA = downloads.download("a", fetchA);
    await downloads.download("b", fetchB);

    const sharesBeforeA = share.mock.calls.length;

    // A's fetch finally resolves, but the superseded call must not share,
    // alert, or steal B's slot.
    resolveA(fetchedFile());
    await pendingA;
    expect(share.mock.calls.length).toBe(sharesBeforeA);

    await downloads.download("b", fetchB);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it("drops a resolved fetch without sharing when the caller's context is gone", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });
    let resolveFetch: (file: FetchedFileForTest) => void = () => undefined;
    const fetchFile = mock(
      () => new Promise<FetchedFileForTest>((resolve) => (resolveFetch = resolve))
    );
    const downloads = createDownloadRetryCache();

    let contextAlive = true;
    const pending = downloads.download("key", fetchFile, () => contextAlive);
    contextAlive = false;
    resolveFetch(fetchedFile());
    await pending;

    expect(share).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("delivers concurrent downloads independently outside iOS standalone", async () => {
    installNavigator({});
    let resolveA: (file: FetchedFileForTest) => void = () => undefined;
    const fetchA = mock(() => new Promise<FetchedFileForTest>((resolve) => (resolveA = resolve)));
    const fetchB = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    // Tap A (fetch hangs), then tap B; both must reach the anchor.
    const pendingA = downloads.download("a", fetchA);
    await downloads.download("b", fetchB);
    resolveA(fetchedFile());
    await pendingA;

    expect(anchor.click).toHaveBeenCalledTimes(2);
  });

  it("does not cache unshareable files, since no retry can succeed", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => false, share });
    const fetchFile = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    await downloads.download("key", fetchFile);
    await downloads.download("key", fetchFile);

    // Each tap refetches: nothing was cached for the unshareable file.
    expect(fetchFile).toHaveBeenCalledTimes(2);
    expect(share).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledTimes(2);
  });

  it("skips the download when the fetch fails", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });
    const fetchFile = mock(() => Promise.resolve(null));
    const downloads = createDownloadRetryCache();

    await downloads.download("key", fetchFile);

    expect(share).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
  });
});
