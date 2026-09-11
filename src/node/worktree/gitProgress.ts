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
    const lines = this.buffer.split(/[\r\n]/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const match = /^(.+?):\s+(\d{1,3})%/.exec(line);
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
      if (done) this.onOutput(line);
    }
  }

  flush(): void {
    if (this.buffer) this.onOutput(this.buffer);
    this.buffer = "";
  }
}
