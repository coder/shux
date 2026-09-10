export const SILENCE_GATE_SAMPLE_INTERVAL_MS = 75;

const MIN_RECORDING_DURATION_MS = 500;
const SPEECH_RMS_THRESHOLD = 0.04;
const MIN_VOICED_DURATION_MS = 300;
const MIN_VOICED_FRAMES = Math.ceil(MIN_VOICED_DURATION_MS / SILENCE_GATE_SAMPLE_INTERVAL_MS);

interface SilenceGateInput {
  rmsFrames: readonly number[];
  durationMs: number;
}

/**
 * Whisper can hallucinate text from silence, so require sustained speech energy.
 * Missing meter samples fail open so Web Audio failures never block real speech.
 */
export function shouldTranscribeRecording(input: SilenceGateInput): boolean {
  if (input.durationMs < MIN_RECORDING_DURATION_MS) return false;
  if (input.rmsFrames.length === 0) return true;

  const voicedFrames = input.rmsFrames.filter((rms) => rms > SPEECH_RMS_THRESHOLD).length;
  return voicedFrames >= MIN_VOICED_FRAMES;
}
