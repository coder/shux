import { describe, expect, test } from "bun:test";
import { shouldTranscribeRecording } from "./silenceGate";

describe("shouldTranscribeRecording", () => {
  test("skips sustained silence", () => {
    expect(
      shouldTranscribeRecording({ rmsFrames: new Array<number>(8).fill(0), durationMs: 600 })
    ).toBe(false);
  });

  test("transcribes sustained speech energy", () => {
    expect(
      shouldTranscribeRecording({
        rmsFrames: [0.01, 0.05, 0.06, 0.05, 0.07, 0.01, 0.01, 0.01],
        durationMs: 600,
      })
    ).toBe(true);
  });

  test("skips a brief energy blip", () => {
    expect(
      shouldTranscribeRecording({
        rmsFrames: [0.08, 0.08, 0.08, 0.01, 0.01, 0.01, 0.01, 0.01],
        durationMs: 600,
      })
    ).toBe(false);
  });

  test("skips trivially short recordings even when voiced", () => {
    expect(
      shouldTranscribeRecording({
        rmsFrames: new Array<number>(8).fill(0.1),
        durationMs: 499,
      })
    ).toBe(false);
  });

  test("fails open when metering produced no samples", () => {
    expect(shouldTranscribeRecording({ rmsFrames: [], durationMs: 600 })).toBe(true);
  });

  test("requires energy to exceed the speech threshold", () => {
    expect(
      shouldTranscribeRecording({
        rmsFrames: new Array<number>(8).fill(0.04),
        durationMs: 600,
      })
    ).toBe(false);
    expect(
      shouldTranscribeRecording({
        rmsFrames: [0.041, 0.041, 0.041, 0.041, 0, 0, 0, 0],
        durationMs: 600,
      })
    ).toBe(true);
  });
});
