import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { APIClient } from "@/browser/contexts/API";
import { installDom } from "../../../tests/ui/dom";
import { copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireTestModule } from "@/browser/testUtils";
import type * as VoiceInputModule from "./useVoiceInput";

let useVoiceInput: typeof VoiceInputModule.useVoiceInput;

let sampleByte = 128;
let sampleAudioFrame: (() => void) | null = null;
let stopTrack = mock(() => undefined);
let stream = createMediaStream();

class MediaRecorderMock {
  static isTypeSupported(_mimeType: string): boolean {
    return true;
  }

  readonly stream: MediaStream;
  state: RecordingState = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(mediaStream: MediaStream) {
    this.stream = mediaStream;
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

class AnalyserNodeMock {
  frequencyBinCount = 128;
  fftSize = 256;
  smoothingTimeConstant = 0;

  getByteTimeDomainData(data: Uint8Array<ArrayBufferLike>): void {
    data.fill(sampleByte);
  }
}

class AudioContextMock {
  createAnalyser(): AnalyserNode {
    return new AnalyserNodeMock() as unknown as AnalyserNode;
  }

  createMediaStreamSource(_stream: MediaStream): MediaStreamAudioSourceNode {
    return {
      connect: (_destination: AudioNode) => undefined,
    } as unknown as MediaStreamAudioSourceNode;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function createMediaStream(): MediaStream {
  return {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
}

const getUserMedia = mock((_constraints: MediaStreamConstraints) => Promise.resolve(stream));
const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
const originalMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, "mediaDevices");

function installVoiceGlobals(): void {
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: MediaRecorderMock as unknown as typeof MediaRecorder,
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: AudioContextMock as unknown as typeof AudioContext,
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

function restoreGlobal(
  name: "MediaRecorder" | "AudioContext",
  descriptor?: PropertyDescriptor
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function sampleFrames(count: number): void {
  const sample = sampleAudioFrame;
  if (!sample) throw new Error("Expected voice input metering to be active");

  for (let index = 0; index < count; index += 1) sample();
}

function renderVoiceInput(useRecordingKeybinds = false) {
  const transcribe = mock((_input: { audioBase64: string }) =>
    Promise.resolve({
      success: true as const,
      data: "transcript",
    })
  );
  const onSend = mock(() => undefined);
  const hook = renderHook(() =>
    useVoiceInput({
      useRecordingKeybinds,
      onSend,
      api: { voice: { transcribe } } as unknown as APIClient,
      isTranscriptionAvailable: true,
      onTranscript: mock(() => undefined),
    })
  );

  return { ...hook, transcribe, onSend };
}

describe("useVoiceInput", () => {
  let cleanupDom: (() => void) | null = null;
  let isolatedModulePath: string;

  beforeEach(async () => {
    cleanupDom = installDom();
    stopTrack = mock(() => undefined);
    stream = createMediaStream();
    sampleByte = 128;
    sampleAudioFrame = null;
    getUserMedia.mockClear();
    installVoiceGlobals();
    // Module-level key tracking must bind to this test's window, not a discarded DOM.
    isolatedModulePath = fileURLToPath(
      new URL(`./useVoiceInput.real.${randomUUID()}.ts`, import.meta.url)
    );
    await copyFile(
      fileURLToPath(new URL("./useVoiceInput.ts", import.meta.url)),
      isolatedModulePath
    );
    ({ useVoiceInput } = requireTestModule<typeof VoiceInputModule>(isolatedModulePath));
    setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    window.setInterval = ((handler: () => void) => {
      sampleAudioFrame = handler;
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = ((_handle?: number) => {
      sampleAudioFrame = null;
    }) as typeof window.clearInterval;
  });

  afterEach(async () => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    setSystemTime();
    await rm(isolatedModulePath, { force: true });
  });

  afterAll(() => {
    restoreGlobal("MediaRecorder", originalMediaRecorder);
    restoreGlobal("AudioContext", originalAudioContext);
    if (originalMediaDevices) {
      Object.defineProperty(globalThis.navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(globalThis.navigator, "mediaDevices");
    }
  });

  function desktopCanvas() {
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    document.body.appendChild(viewport);
    return canvas;
  }

  test.each([
    { key: "Escape", cancel: true, send: false },
    { key: " ", cancel: false, send: true },
    { key: "d", ctrlKey: true, cancel: false, send: false },
    { key: "d", metaKey: true, cancel: false, send: false },
  ])("guest recording shortcut %j leaves host recording unchanged", async (shortcut) => {
    Object.defineProperty(navigator, "platform", {
      value: "metaKey" in shortcut ? "MacIntel" : "Linux",
    });
    const { result, transcribe, onSend } = renderVoiceInput(true);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    const canvas = desktopCanvas();
    const event = new window.KeyboardEvent("keydown", {
      ...shortcut,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      canvas.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(result.current.state).toBe("recording");
    expect(stopTrack).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      document.body.dispatchEvent(
        new window.KeyboardEvent("keydown", { ...shortcut, bubbles: true })
      );
    });
    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(transcribe).toHaveBeenCalledTimes(shortcut.cancel ? 0 : 1);
    expect(onSend).toHaveBeenCalledTimes(shortcut.send ? 1 : 0);
  });

  test("guest Space keyup cannot clear the host held-at-start guard", async () => {
    const { result, transcribe } = renderVoiceInput(true);
    const canvas = desktopCanvas();
    document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    canvas.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    act(() => {
      document.body.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true })
      );
    });
    expect(result.current.state).toBe("recording");
    expect(transcribe).not.toHaveBeenCalled();
    document.body.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    act(() => {
      document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  });

  test("guest Space held before recording cannot suppress the first host send", async () => {
    const { result, onSend } = renderVoiceInput(true);
    desktopCanvas().dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    act(() => {
      document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  test("does not transcribe a silent recording", async () => {
    const { result, transcribe } = renderVoiceInput();

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.state).toBe("idle"));

    expect(transcribe).not.toHaveBeenCalled();
  });

  test("transcribes a voiced recording", async () => {
    const { result, transcribe } = renderVoiceInput();

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.state).toBe("idle"));

    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
