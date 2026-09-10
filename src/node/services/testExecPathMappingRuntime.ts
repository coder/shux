import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { ExecOptions, ExecStream } from "@/node/runtime/Runtime";

/**
 * Test runtime whose exec namespace differs from the host namespace: paths under
 * hostPrefix are remapped to execPrefix (cwd and pathEnv), like DevcontainerRuntime.
 */
export class ExecPathMappingRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly hostPrefix: string,
    private readonly execPrefix: string
  ) {
    super(projectPath);
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const mapPath = (filePath: string) =>
      filePath.startsWith(this.hostPrefix)
        ? this.execPrefix + filePath.slice(this.hostPrefix.length)
        : filePath;
    return super.exec(command, {
      ...options,
      cwd: mapPath(options.cwd),
      pathEnv: Object.fromEntries(
        Object.entries(options.pathEnv ?? {}).map(([key, value]) => [key, mapPath(value)])
      ),
    });
  }
}
