import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Config } from "@/node/config";

// chmod-based error injection is meaningless where permission bits don't
// bind: root bypasses them (common in containerized CI) and Windows ACLs
// ignore POSIX modes entirely.
const permissionBitsEnforced =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

/** The rejection of a promise that must reject. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the promise to reject");
}

describe("Config telemetryEnabled persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-telemetry-enabled-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fails closed when config.json exists but cannot be parsed", async () => {
    const config = new Config(tempDir);
    // Fresh install (no file) is not an error: telemetry stays enabled.
    expect(config.isTelemetryDisabledByConfig()).toBe(false);

    // A corrupted file must not silently override a possible opt-out:
    // unreadable persisted state reports disabled.
    await fs.writeFile(path.join(tempDir, "config.json"), "{ not json", "utf-8");
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
  });

  it.skipIf(!permissionBitsEnforced)(
    "fails closed when the config directory is inaccessible",
    async () => {
      const config = new Config(tempDir);
      await fs.writeFile(path.join(tempDir, "config.json"), JSON.stringify({}), "utf-8");
      expect(config.isTelemetryDisabledByConfig()).toBe(false);

      // existsSync() masks EACCES as "missing"; the stat-based check must treat
      // an unreachable ~/.mux as a possible opt-out, not as enabled-by-default.
      await fs.chmod(tempDir, 0o000);
      try {
        expect(config.isTelemetryDisabledByConfig()).toBe(true);
      } finally {
        await fs.chmod(tempDir, 0o700);
      }
    }
  );

  it("fails closed when telemetryEnabled is present but not a boolean", async () => {
    const config = new Config(tempDir);
    // Valid JSON with a corrupted field: parse succeeds, so the unreadable-file
    // guard never fires — the field itself must read as disabled, not as an
    // absent opt-out that re-enables telemetry.
    for (const corrupted of ['"false"', "null", "0", '"yes"']) {
      await fs.writeFile(
        path.join(tempDir, "config.json"),
        `{ "telemetryEnabled": ${corrupted} }`,
        "utf-8"
      );
      expect(config.loadConfigOrDefault().telemetryEnabled).toBe(false);
      expect(config.isTelemetryDisabledByConfig()).toBe(true);
    }

    // A well-formed value keeps its meaning in both directions.
    await fs.writeFile(path.join(tempDir, "config.json"), `{ "telemetryEnabled": true }`, "utf-8");
    expect(config.isTelemetryDisabledByConfig()).toBe(false);
  });

  it("reconciles a crash-split preference from the explicit field on startup", async () => {
    const config = new Config(tempDir);
    const markerPath = path.join(tempDir, "telemetry_opt_out");

    // Crash after the verified opt-out write, before the marker sync: the
    // explicit field recreates the missing marker.
    await fs.writeFile(path.join(tempDir, "config.json"), `{ "telemetryEnabled": false }`, "utf-8");
    await config.reconcileTelemetryOptOutMarker();
    expect(fsSync.existsSync(markerPath)).toBe(true);
    expect(config.isTelemetryDisabledByConfig()).toBe(true);

    // Hand-declared re-enable (explicit true) removes a stale marker.
    await fs.writeFile(path.join(tempDir, "config.json"), `{ "telemetryEnabled": true }`, "utf-8");
    await config.reconcileTelemetryOptOutMarker();
    expect(fsSync.existsSync(markerPath)).toBe(false);
    expect(config.isTelemetryDisabledByConfig()).toBe(false);

    // Absent field + marker is the downgrade-survivor state: reconciliation
    // must NOT remove the marker (crash-mid-enable is indistinguishable, and
    // fail-closed is the privacy-safe direction).
    await config.setTelemetryEnabledPersisted(false);
    await fs.writeFile(path.join(tempDir, "config.json"), "{}", "utf-8");
    await config.reconcileTelemetryOptOutMarker();
    expect(fsSync.existsSync(markerPath)).toBe(true);
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
  });

  it("keeps the opt-out when an older build's save drops the field (marker backstop)", async () => {
    const config = new Config(tempDir);
    config.setTelemetryOptOutMarker(true);

    // Simulate the downgrade round-trip: an older build's whitelist-based
    // saveConfig rewrites config.json without the (to it unknown) field.
    await fs.writeFile(path.join(tempDir, "config.json"), "{}", "utf-8");
    expect(config.isTelemetryDisabledByConfig()).toBe(true);

    // Re-enabling clears the marker: absent field + no marker reads enabled.
    config.setTelemetryOptOutMarker(false);
    expect(config.isTelemetryDisabledByConfig()).toBe(false);
  });

  it("self-heals a directory-shaped marker so the toggle can re-enable telemetry", async () => {
    const config = new Config(tempDir);
    const markerPath = path.join(tempDir, "telemetry_opt_out");
    await fs.mkdir(markerPath);

    // Corrupted state reads fail-closed (disabled)...
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
    // ...but an explicit re-enable must not fail forever on EISDIR (and roll
    // its field back) while the directory keeps forcing the opt-out.
    await config.setTelemetryEnabledPersisted(true);
    expect(fsSync.existsSync(markerPath)).toBe(false);
    expect(config.isTelemetryDisabledByConfig()).toBe(false);
    // Unknown content is quarantined, not destroyed.
    const quarantined = (await fs.readdir(tempDir)).filter((name) =>
      name.startsWith("telemetry_opt_out.")
    );
    expect(quarantined).toHaveLength(1);

    // Opting out over a directory-shaped marker writes a real marker file.
    await fs.mkdir(markerPath);
    await config.setTelemetryEnabledPersisted(false);
    expect((await fs.lstat(markerPath)).isFile()).toBe(true);
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
  });

  it("quarantines a symlink-shaped marker instead of writing through it", async () => {
    const config = new Config(tempDir);
    const markerPath = path.join(tempDir, "telemetry_opt_out");
    const victim = path.join(tempDir, "victim.txt");
    await fs.writeFile(victim, "precious", "utf-8");
    await fs.symlink(victim, markerPath);

    // A link reads as an opt-out (fail closed) but is never a healthy marker:
    // recreating the marker from an explicit false field must not follow it
    // into the target.
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
    await fs.writeFile(path.join(tempDir, "config.json"), `{ "telemetryEnabled": false }`, "utf-8");
    await config.reconcileTelemetryOptOutMarker();
    expect(await fs.readFile(victim, "utf-8")).toBe("precious");
    expect((await fs.lstat(markerPath)).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(markerPath)).isFile()).toBe(true);
    const quarantined = (await fs.readdir(tempDir)).filter((name) =>
      name.startsWith("telemetry_opt_out.malformed-")
    );
    expect(quarantined).toHaveLength(1);
    expect((await fs.lstat(path.join(tempDir, quarantined[0]))).isSymbolicLink()).toBe(true);

    // Re-enabling over a planted link removes the link, never the target.
    await fs.rm(markerPath);
    await fs.symlink(victim, markerPath);
    await config.setTelemetryEnabledPersisted(true);
    expect(await fs.readFile(victim, "utf-8")).toBe("precious");
    expect(fsSync.existsSync(markerPath)).toBe(false);
    expect(config.isTelemetryDisabledByConfig()).toBe(false);
  });

  it("never truncates a hard-linked marker in place", async () => {
    // lstat reports a hard link as a plain file and O_NOFOLLOW cannot see it:
    // writing the marker through the shared inode would overwrite the other
    // name's content. The marker must be a fresh inode renamed over the path.
    const config = new Config(tempDir);
    const markerPath = path.join(tempDir, "telemetry_opt_out");
    const victim = path.join(tempDir, "victim.txt");
    await fs.writeFile(victim, "precious", "utf-8");
    await fs.link(victim, markerPath);

    await fs.writeFile(path.join(tempDir, "config.json"), `{ "telemetryEnabled": false }`, "utf-8");
    await config.reconcileTelemetryOptOutMarker();

    expect(await fs.readFile(victim, "utf-8")).toBe("precious");
    const [markerStat, victimStat] = await Promise.all([fs.stat(markerPath), fs.stat(victim)]);
    expect(markerStat.ino).not.toBe(victimStat.ino);
    expect(victimStat.nlink).toBe(1);
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
    // No temp file left behind.
    expect((await fs.readdir(tempDir)).filter((name) => name.includes(".tmp-"))).toHaveLength(0);
  });

  it("keeps a marker-only opt-out when the replacement marker cannot be written", async () => {
    // After a downgrade round trip, or with a malformed marker and no field,
    // the marker is the only record of the opt-out. A toggle that quarantines
    // it and then fails to write the replacement must roll back to DISABLED:
    // snapshotting just the field reads "enabled", and that rollback would
    // silently enable collection.
    const config = new Config(tempDir);
    const markerPath = path.join(tempDir, "telemetry_opt_out");
    await fs.mkdir(markerPath);
    expect(config.isTelemetryDisabledByConfig()).toBe(true);

    const withMarker = config as unknown as {
      setTelemetryOptOutMarker: (disabled: boolean) => void;
      quarantineMalformedTelemetryOptOutMarker: () => void;
    };
    const markerSpy = spyOn(withMarker, "setTelemetryOptOutMarker").mockImplementation(() => {
      // The real sync quarantines the malformed entry first, then fails.
      withMarker.quarantineMalformedTelemetryOptOutMarker();
      throw new Error("EIO");
    });
    try {
      await rejectionOf(config.setTelemetryEnabledPersisted(false));
    } finally {
      markerSpy.mockRestore();
    }
    expect(config.loadConfigOrDefault().telemetryEnabled).toBe(false);
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
  });

  it("aborts the marker sync when the lock was displaced after the field write", async () => {
    // On platforms without process birth identity a holder stalled past the
    // lease can be reclaimed by a peer that completes a newer toggle. The
    // stale holder must re-validate ownership before the marker mutation:
    // recreating or removing the peer's marker would undo its toggle.
    const config = new Config(tempDir);
    const lockPath = path.join(tempDir, "locks", "project-registration.lock");
    const notifiable = config as unknown as { notifyConfigChanged: () => void };
    const originalNotify = notifiable.notifyConfigChanged.bind(config);
    let displaceOnNextNotify = false;
    // The nested field edit notifies after its save and before the marker
    // sync: displace the lock in that window.
    const notifySpy = spyOn(notifiable, "notifyConfigChanged").mockImplementation(() => {
      if (displaceOnNextNotify && fsSync.existsSync(lockPath)) {
        displaceOnNextNotify = false;
        fsSync.writeFileSync(lockPath, "424242:peer-reclaimed", "utf-8");
      }
      originalNotify();
    });
    try {
      displaceOnNextNotify = true;
      const rejection = await rejectionOf(config.setTelemetryEnabledPersisted(false));
      expect(rejection.message).toMatch(/lock/i);
    } finally {
      notifySpy.mockRestore();
    }
    // The displaced holder never touched the marker.
    expect(fsSync.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(false);
  });

  it("skips the rollback's marker restore when the lock was displaced during the rollback", async () => {
    // The rollback is a mutation under the lock like the forward path: its
    // field edit asserts ownership inside editConfig, and the marker restore
    // that follows must re-validate too — a holder displaced during the
    // awaited edit must not recreate or remove a peer's newer marker.
    const config = new Config(tempDir);
    const lockPath = path.join(tempDir, "locks", "project-registration.lock");
    const withMarker = config as unknown as {
      setTelemetryOptOutMarker: (disabled: boolean) => void;
    };
    const notifiable = config as unknown as { notifyConfigChanged: () => void };
    const originalNotify = notifiable.notifyConfigChanged.bind(config);
    let rollingBack = false;
    // The forward marker sync fails once (after the verified field write),
    // forcing the rollback; the rollback's own field edit notifies after its
    // save — displace the lock in that window, before the marker restore.
    const markerSpy = spyOn(withMarker, "setTelemetryOptOutMarker").mockImplementationOnce(() => {
      rollingBack = true;
      throw new Error("EIO");
    });
    const notifySpy = spyOn(notifiable, "notifyConfigChanged").mockImplementation(() => {
      if (rollingBack && fsSync.existsSync(lockPath)) {
        rollingBack = false;
        fsSync.writeFileSync(lockPath, "424242:peer-reclaimed", "utf-8");
      }
      originalNotify();
    });
    let rejection: Error;
    try {
      rejection = await rejectionOf(config.setTelemetryEnabledPersisted(false));
    } finally {
      notifySpy.mockRestore();
    }
    // mockRestore() also clears the call history, so read it first.
    const markerCalls = markerSpy.mock.calls.length;
    markerSpy.mockRestore();
    expect(rejection.message).toMatch(/opt-out marker/);
    // The forward sync was attempted once; the displaced rollback never
    // touched the marker.
    expect(markerCalls).toBe(1);
    expect(fsSync.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(false);
  });

  it("leaves the marker alone when the startup reconciliation lock was displaced", async () => {
    // Startup reconciliation mutates the marker from the explicit field. A hold
    // displaced between the field read and that mutation (a peer completed a
    // newer toggle meanwhile) must not create or remove the peer's marker.
    const config = new Config(tempDir);
    await fs.writeFile(path.join(tempDir, "config.json"), `{ "telemetryEnabled": false }`, "utf-8");
    const lockPath = path.join(tempDir, "locks", "project-registration.lock");
    const original = config.loadConfigOrDefault.bind(config);
    const loadSpy = spyOn(config, "loadConfigOrDefault").mockImplementation(((options?: {
      throwOnError?: boolean;
    }) => {
      const result = original(options);
      // Displace the hold right after the field read, before the marker mutation.
      if (fsSync.existsSync(lockPath)) {
        fsSync.writeFileSync(lockPath, "424242:peer-reclaimed", "utf-8");
      }
      return result;
    }) as typeof config.loadConfigOrDefault);
    try {
      await config.reconcileTelemetryOptOutMarker();
    } finally {
      loadSpy.mockRestore();
    }
    expect(fsSync.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(false);
  });

  it("a telemetry toggle does not deadlock against an in-flight unrelated edit", async () => {
    const config = new Config(tempDir);
    // An ordinary editConfig mid-save — holding its queue permit and its own
    // hold of the registration file lock — while the toggle starts. The toggle
    // must WAIT for the file lock, and once it owns it, its nested field edits
    // must commit under that hold (never try to take the lock again and never
    // park behind the toggle itself) — either mistake wedges both callers.
    const withSave = config as unknown as { saveConfig: (c: unknown) => Promise<void> };
    const originalSave = withSave.saveConfig.bind(config);
    let firstSave = true;
    const saveSpy = spyOn(withSave, "saveConfig").mockImplementation(async (c: unknown) => {
      if (firstSave) {
        firstSave = false;
        // Hold the first edit's lock across the toggle's arrival.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return originalSave(c);
    });
    try {
      await Promise.all([
        config.editConfig((cfg) => ({ ...cfg, chatTranscriptFullWidth: true })),
        config.setTelemetryEnabledPersisted(false),
      ]);
    } finally {
      saveSpy.mockRestore();
    }

    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);
    expect(config.loadConfigOrDefault().telemetryEnabled).toBe(false);
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
  });

  it("toggles on a fresh home, creating the root and the lock directory first", async () => {
    // First run: neither the home nor its locks/ directory exists yet. The
    // transaction must create them and take the registration lock, not fail
    // (or silently run unlocked) on ENOENT.
    const freshRoot = path.join(tempDir, "nested", "fresh-home");
    const config = new Config(freshRoot);

    await config.setTelemetryEnabledPersisted(false);

    expect(config.loadConfigOrDefault().telemetryEnabled).toBe(false);
    expect(fsSync.existsSync(path.join(freshRoot, "telemetry_opt_out"))).toBe(true);
    // The lock released cleanly.
    expect(fsSync.existsSync(path.join(freshRoot, "locks", "project-registration.lock"))).toBe(
      false
    );
  });

  it("notifies clients again after the marker sync completes", async () => {
    const config = new Config(tempDir);
    await config.setTelemetryEnabledPersisted(false);
    expect(fsSync.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(true);

    // The nested field edit notifies before the marker is touched; a peer
    // reading marker-aware state on that early event would still see the old
    // effective value, so a final post-transaction notification must fire
    // once the marker agrees with the field.
    const markerStateAtNotify: boolean[] = [];
    const notifiable = config as unknown as { notifyConfigChanged: () => void };
    const originalNotify = notifiable.notifyConfigChanged.bind(config);
    const notifySpy = spyOn(notifiable, "notifyConfigChanged").mockImplementation(() => {
      markerStateAtNotify.push(fsSync.existsSync(path.join(tempDir, "telemetry_opt_out")));
      originalNotify();
    });
    try {
      await config.setTelemetryEnabledPersisted(true);
    } finally {
      notifySpy.mockRestore();
    }

    expect(markerStateAtNotify.length).toBeGreaterThanOrEqual(2);
    // The last notification observes the completed transaction: marker gone.
    expect(markerStateAtNotify[markerStateAtNotify.length - 1]).toBe(false);
  });

  it("round-trips the opt-out through editConfig saves and reports it", async () => {
    const config = new Config(tempDir);
    expect(config.isTelemetryDisabledByConfig()).toBe(false);

    await config.editConfig((cfg) => ({ ...cfg, telemetryEnabled: false }));

    // A fresh instance re-reads from disk: the field must survive the
    // whitelist-based saveConfig serialization.
    const reloaded = new Config(tempDir);
    expect(reloaded.loadConfigOrDefault().telemetryEnabled).toBe(false);
    expect(reloaded.isTelemetryDisabledByConfig()).toBe(true);

    // Clearing the field (re-enable) must persist too.
    await reloaded.editConfig((cfg) => ({ ...cfg, telemetryEnabled: undefined }));
    const cleared = new Config(tempDir);
    expect(cleared.loadConfigOrDefault().telemetryEnabled).toBeUndefined();
    expect(cleared.isTelemetryDisabledByConfig()).toBe(false);
  });
});
