import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getXumHome } from "@/common/constants/paths";
import { log } from "@/node/services/log";

const ASKPASS_SCRIPT = `#!/bin/sh
# mux-askpass — SSH_ASKPASS helper for Xum
# Each invocation is an independent request/response transaction identified
# by a unique ID, so multiple prompts per SSH handshake are handled correctly.
# Uses only regular files (no mkfifo) for cross-platform portability.
req_id="$$.$(date +%s%N)"
prompt_file="$MUX_ASKPASS_DIR/prompt.$req_id.txt"
response_file="$MUX_ASKPASS_DIR/response.$req_id.txt"
printf '%s' "$1" > "$prompt_file"
# Poll for response file (60s timeout = 1200 × 50ms)
i=0
while [ "$i" -lt 1200 ]; do
  if [ -f "$response_file" ]; then
    cat "$response_file"
    rm -f "$prompt_file" "$response_file"
    exit 0
  fi
  sleep 0.05
  i=$((i + 1))
done
exit 1
`;

let askpassPath: string | undefined;

function extractRequestId(filename: string): string | undefined {
  const match = /^prompt\.(.+)\.txt$/.exec(filename);
  return match?.[1];
}

async function ensureAskpassScript(): Promise<string> {
  if (askpassPath) {
    try {
      await fs.promises.access(askpassPath, fs.constants.X_OK);
      return askpassPath;
    } catch {
      // Recreate the helper script if it was deleted.
    }
  }

  // Write under the canonical home so a missing ~/.mux alias cannot create a
  // split tree. Keep the mux-askpass filename stable for existing SSH sessions.
  const dir = path.join(getXumHome(), "bin");
  await fs.promises.mkdir(dir, { recursive: true });
  askpassPath = path.join(dir, "mux-askpass");
  await fs.promises.writeFile(askpassPath, ASKPASS_SCRIPT, { mode: 0o755 });
  return askpassPath;
}

/** Parse host/keyType/fingerprint from OpenSSH output. */
export function parseHostKeyPrompt(text: string): {
  host: string;
  keyType: string;
  fingerprint: string;
  prompt: string;
} {
  const hostMatch = /authenticity of host '([^']+)'/.exec(text);
  const keyMatch = /(\w+) key fingerprint is (SHA256:\S+)/.exec(text);
  return {
    host: hostMatch?.[1] ?? "unknown",
    keyType: keyMatch?.[1] ?? "unknown",
    fingerprint: keyMatch?.[2] ?? "unknown",
    prompt: text.trim(),
  };
}

export interface AskpassSession {
  /** Merge into the spawn env: { ...process.env, ...env } */
  env: Record<string, string>;
  /** Must be called when the SSH process exits. */
  cleanup(): void;
}

/**
 * Creates a per-probe askpass session.
 *
 * @param onPrompt Called when askpass fires. Receives the prompt text,
 *   must return the response string (e.g. "yes" or "no").
 */
export async function createAskpassSession(
  onPrompt: (prompt: string) => Promise<string>
): Promise<AskpassSession> {
  // Resolve script path before allocating temp resources.
  const scriptPath = await ensureAskpassScript();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-askpass-"));
  const processed = new Set<string>();
  let closed = false;

  async function handlePrompt(requestId: string): Promise<void> {
    const promptFile = path.join(dir, `prompt.${requestId}.txt`);
    const responseFile = path.join(dir, `response.${requestId}.txt`);

    try {
      await fs.promises.access(promptFile);
    } catch {
      processed.delete(requestId);
      return;
    }

    if (closed) return;

    try {
      const promptText = await fs.promises.readFile(promptFile, "utf-8");
      const response = await onPrompt(promptText);
      await fs.promises.writeFile(responseFile, response + "\n");
    } catch (err) {
      log.debug("Askpass prompt handling failed:", err);
      // Write rejection to unblock askpass (best-effort)
      try {
        await fs.promises.writeFile(responseFile, "no\n");
      } catch {
        /* askpass may already be gone */
      }
    }
  }

  // Watch for askpass to write prompt files.
  // fs.watch is set up BEFORE SSH is spawned, so we cannot miss events.
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, (_, filename) => {
      if (closed) return;

      void (async () => {
        let candidateFilenames: string[];
        if (typeof filename === "string") {
          candidateFilenames = [filename];
        } else {
          try {
            candidateFilenames = await fs.promises.readdir(dir);
          } catch {
            return;
          }
        }

        for (const candidate of candidateFilenames) {
          const requestId = extractRequestId(candidate);
          if (!requestId || processed.has(requestId)) {
            continue;
          }

          processed.add(requestId);
          void handlePrompt(requestId);
        }
      })();
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    env: {
      SSH_ASKPASS: scriptPath,
      // Force askpass usage even with a controlling terminal (OpenSSH 8.4+)
      SSH_ASKPASS_REQUIRE: "force",
      // Enable askpass on pre-8.4 OpenSSH (DISPLAY must be non-empty)
      DISPLAY: process.env.DISPLAY ?? "mux",
      MUX_ASKPASS_DIR: dir,
    },
    cleanup() {
      closed = true;
      watcher.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
