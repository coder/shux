import { describe, expect, test } from "bun:test";

import {
  estimatePersistedChatAttachmentsChars,
  parsePersistedChatAttachments,
} from "./draftAttachmentsStorage";

describe("draftAttachmentsStorage", () => {
  test("parsePersistedChatAttachments returns [] for non-arrays", () => {
    expect(parsePersistedChatAttachments(null)).toEqual([]);
    expect(parsePersistedChatAttachments({})).toEqual([]);
    expect(parsePersistedChatAttachments("nope")).toEqual([]);
  });

  test("parsePersistedChatAttachments returns [] for invalid array items", () => {
    expect(parsePersistedChatAttachments([{}])).toEqual([]);
    expect(
      parsePersistedChatAttachments([{ id: "img", url: 123, mediaType: "image/png" }])
    ).toEqual([]);
  });

  test("parsePersistedChatAttachments returns attachments for valid items", () => {
    expect(
      parsePersistedChatAttachments([
        { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
      ])
    ).toEqual([
      { kind: "provider", id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
    ]);
  });

  test("parsePersistedChatAttachments returns staged file metadata without base64", () => {
    expect(
      parsePersistedChatAttachments([
        {
          kind: "staged",
          id: "zip-1",
          mediaType: "application/zip",
          filename: "archive.zip",
          sizeBytes: 123,
          stagedPath: ".mux/user-attachments/id/archive.zip",
        },
      ])
    ).toEqual([
      {
        kind: "staged",
        id: "zip-1",
        mediaType: "application/zip",
        filename: "archive.zip",
        sizeBytes: 123,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);
  });

  test("parsePersistedChatAttachments self-heals invalid staged records", () => {
    expect(
      parsePersistedChatAttachments([
        {
          kind: "staged",
          id: "zip-1",
          mediaType: "application/zip",
          filename: "archive.zip",
          sizeBytes: "123",
          stagedPath: ".mux/user-attachments/id/archive.zip",
        },
      ])
    ).toEqual([]);
  });

  test("parsePersistedChatAttachments round-trips pending files with base64 bytes", () => {
    const pendingFile = {
      kind: "pending-file" as const,
      id: "pending-1",
      mediaType: "text/markdown",
      filename: "notes.md",
      sizeBytes: 8,
      dataBase64: "bWFya2Rvd24=",
    };
    expect(parsePersistedChatAttachments([pendingFile])).toEqual([pendingFile]);
  });

  test("parsePersistedChatAttachments self-heals invalid pending-file records", () => {
    expect(
      parsePersistedChatAttachments([
        {
          kind: "pending-file",
          id: "pending-1",
          mediaType: "text/markdown",
          filename: "notes.md",
          sizeBytes: 8,
        },
      ])
    ).toEqual([]);
  });

  test("estimatePersistedChatAttachmentsChars matches JSON length", () => {
    const attachments = [
      {
        kind: "provider" as const,
        id: "img-1",
        url: "data:image/png;base64,AAA",
        mediaType: "image/png",
      },
    ];
    expect(estimatePersistedChatAttachmentsChars(attachments)).toBe(
      JSON.stringify(attachments).length
    );
  });
});
