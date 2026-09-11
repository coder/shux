const PROGRESS_LINE = /^(.+?):\s+(\d{1,3})%/;

export function isGitProgressLine(line: string): boolean {
  return PROGRESS_LINE.test(line);
}

export class GitProgressParser {
  private buffer = "";
  private lastStage: string | undefined;
  private lastPercent: number | undefined;

  constructor(
    private readonly onProgress: (stage: string, percent: number) => void,
    private readonly onOutput: (line: string) => void
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/([\r\n])/);
    this.buffer = lines.pop() ?? "";
    for (let index = 0; index < lines.length; index += 2) {
      const line = lines[index];
      if (!line) continue;
      const match = PROGRESS_LINE.exec(line);
      if (!match) {
        this.onOutput(line);
        continue;
      }
      const stage = match[1];
      const done = /\bdone\.\s*$/.test(line);
      const percent = done ? 100 : Number(match[2]);
      if (stage !== this.lastStage || percent !== this.lastPercent) {
        this.lastStage = stage;
        this.lastPercent = percent;
        this.onProgress(stage, percent);
      }
      if (done || lines[index + 1] === "\n") this.onOutput(line);
    }
  }

  flush(): void {
    if (this.buffer) this.onOutput(this.buffer);
    this.buffer = "";
  }
}
