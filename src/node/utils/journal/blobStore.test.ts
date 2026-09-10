import { describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { BlobStore } from "./blobStore";

describe("BlobStore", () => {
  test("roundtrips text content by hash", async () => {
    using tmp = new DisposableTempDir("blobstore-test");
    const store = new BlobStore(tmp.path);
    const { ref, size } = await store.put("hello blob world");
    expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(size).toBe("hello blob world".length);
    expect(await store.getText(ref)).toBe("hello blob world");
    expect(await store.has(ref)).toBe(true);
  });

  test("stores identical content once (same ref, one file)", async () => {
    using tmp = new DisposableTempDir("blobstore-test");
    const store = new BlobStore(tmp.path);
    const first = await store.put("same content");
    const second = await store.put("same content");
    expect(second.ref).toBe(first.ref);

    const fanoutDir = path.join(tmp.path, first.ref.slice("sha256:".length, "sha256:".length + 2));
    const files = await fs.readdir(fanoutDir);
    expect(files).toHaveLength(1);
  });

  test("returns null for missing blobs and corrupted blobs (hash mismatch)", async () => {
    using tmp = new DisposableTempDir("blobstore-test");
    const store = new BlobStore(tmp.path);
    const missingRef = `sha256:${"0".repeat(64)}` as const;
    expect(await store.get(missingRef)).toBeNull();

    const { ref } = await store.put("legit content");
    // Corrupt the blob on disk; get() must detect the mismatch and self-heal to null.
    const hash = ref.slice("sha256:".length);
    const blobPath = path.join(tmp.path, hash.slice(0, 2), hash);
    await fs.writeFile(blobPath, "tampered");
    expect(await store.get(ref)).toBeNull();
  });

  test("put repairs a corrupted existing blob instead of trusting the path", async () => {
    using tmp = new DisposableTempDir("blobstore-test");
    const store = new BlobStore(tmp.path);
    const { ref } = await store.put("legit content");
    const hash = ref.slice("sha256:".length);
    const blobPath = path.join(tmp.path, hash.slice(0, 2), hash);
    await fs.writeFile(blobPath, "tampered");
    expect(await store.get(ref)).toBeNull();

    // Re-putting the original content must rewrite the corrupt file so the
    // blob becomes readable again (otherwise the ref is poisoned forever).
    const again = await store.put("legit content");
    expect(again.ref).toBe(ref);
    expect(await store.getText(ref)).toBe("legit content");
  });

  test("rejects malformed refs (crash-fast on programmer error)", async () => {
    using tmp = new DisposableTempDir("blobstore-test");
    const store = new BlobStore(tmp.path);
    try {
      await store.get("md5:abc" as never);
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("Invalid blob ref");
    }
  });

  test("roundtrips binary content", async () => {
    using tmp = new DisposableTempDir("blobstore-test");
    const store = new BlobStore(tmp.path);
    const bytes = new Uint8Array([0, 255, 1, 254, 2, 253]);
    const { ref } = await store.put(bytes);
    const back = await store.get(ref);
    expect(back).not.toBeNull();
    expect(new Uint8Array(back!)).toEqual(bytes);
  });
});
