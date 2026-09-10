import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const workerBudget = require("../scripts/lib/worker_budget.js");

const GIB = 1024 ** 3;

interface FakeCgroup {
  cgroupRoot: string;
  procSelfCgroup: string;
}

function writeFakeCgroup(
  root: string,
  leafPath: string,
  dirs: Record<string, Record<string, string>>,
  procLine = `0::${leafPath}`
): FakeCgroup {
  const cgroupRoot = path.join(root, "cgroup");
  for (const [cgroupPath, files] of Object.entries(dirs)) {
    const dir = path.join(cgroupRoot, cgroupPath);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
  }

  const procSelfCgroup = path.join(root, "proc-self-cgroup");
  fs.writeFileSync(procSelfCgroup, `${procLine}\n`);
  return { cgroupRoot, procSelfCgroup };
}

function memoryStat(overrides: Record<string, number>): string {
  return Object.entries(overrides)
    .map(([key, value]) => `${key} ${value}`)
    .join("\n");
}

describe("worker budget cgroup resolution", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worker-budget-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("takes the cap from the constraining ancestor when the leaf is unlimited", () => {
    const fake = writeFakeCgroup(tmpRoot, "/init.scope", {
      "/": { "memory.max": `${32 * GIB}` },
      "/init.scope": { "memory.max": "max" },
    });

    const constraint = workerBudget.resolveMemoryConstraint(fake);

    expect(constraint.limitBytes).toBe(32 * GIB);
    expect(constraint.dir).toBe(fake.cgroupRoot);
  });

  it("prefers the tightest cap when several ancestors impose one", () => {
    const fake = writeFakeCgroup(tmpRoot, "/parent/leaf", {
      "/": { "memory.max": `${64 * GIB}` },
      "/parent": { "memory.max": `${8 * GIB}` },
      "/parent/leaf": { "memory.max": `${16 * GIB}` },
    });

    expect(workerBudget.resolveMemoryConstraint(fake).limitBytes).toBe(8 * GIB);
  });

  it("uses the broadest usage scope when equal caps constrain multiple levels", () => {
    const fake = writeFakeCgroup(tmpRoot, "/parent/leaf", {
      "/": { "memory.max": `${64 * GIB}` },
      "/parent": { "memory.max": `${8 * GIB}` },
      "/parent/leaf": { "memory.max": `${8 * GIB}` },
    });

    const constraint = workerBudget.resolveMemoryConstraint(fake);

    expect(constraint.limitBytes).toBe(8 * GIB);
    expect(constraint.dir).toBe(path.join(fake.cgroupRoot, "parent"));
  });

  it("ignores saturated integers that stand in for 'unlimited'", () => {
    const fake = writeFakeCgroup(tmpRoot, "/leaf", {
      "/": { "memory.max": "9223372036854771712" },
      "/leaf": { "memory.max": "max" },
    });

    expect(workerBudget.resolveMemoryConstraint(fake)).toBeNull();
  });

  it("resolves a nested cgroup v1 memory limit", () => {
    const fake = writeFakeCgroup(
      tmpRoot,
      "/docker/leaf",
      {
        "/memory": { "memory.limit_in_bytes": `${16 * GIB}` },
        "/memory/docker": { "memory.limit_in_bytes": `${8 * GIB}` },
        "/memory/docker/leaf": { "memory.limit_in_bytes": `${4 * GIB}` },
      },
      "5:cpu,memory:/docker/leaf"
    );

    const constraint = workerBudget.resolveMemoryConstraint(fake);

    expect(constraint.limitBytes).toBe(4 * GIB);
    expect(constraint.dir).toBe(path.join(fake.cgroupRoot, "memory/docker/leaf"));
  });

  it("reports no constraint when the host has no cgroup files", () => {
    const fake = writeFakeCgroup(tmpRoot, "/", { "/": {} });

    expect(workerBudget.resolveMemoryConstraint(fake)).toBeNull();
  });
});

describe("worker budget usage accounting", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worker-budget-usage-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("excludes reclaimable page cache from usage", () => {
    const dir = path.join(tmpRoot, "cg");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "memory.current"), `${20 * GIB}`);
    fs.writeFileSync(
      path.join(dir, "memory.stat"),
      memoryStat({ anon: 4 * GIB, kernel: GIB, shmem: 0, inactive_file: 15 * GIB })
    );

    expect(workerBudget.readCgroupUsageBytes(dir)).toBe(5 * GIB);
  });

  it("counts file-backed memory that cannot be reclaimed", () => {
    const dir = path.join(tmpRoot, "cg");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "memory.current"), `${20 * GIB}`);
    fs.writeFileSync(
      path.join(dir, "memory.stat"),
      memoryStat({ anon: 4 * GIB, kernel: GIB, shmem: 0, inactive_file: 2 * GIB })
    );

    expect(workerBudget.readCgroupUsageBytes(dir)).toBe(18 * GIB);
  });

  it("subtracts reclaimable cache from cgroup v1 usage", () => {
    const dir = path.join(tmpRoot, "cg-v1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "memory.usage_in_bytes"), `${20 * GIB}`);
    fs.writeFileSync(path.join(dir, "memory.stat"), memoryStat({ total_inactive_file: 15 * GIB }));

    expect(workerBudget.readCgroupUsageBytes(dir)).toBe(5 * GIB);
  });
});

describe("worker budget sizing", () => {
  const base = { cpuCount: 96, memoryPerWorkerGib: 4, maxWorkers: 4 };

  it("sizes against memory rather than the visible core count", () => {
    expect(workerBudget.computeWorkers({ ...base, limitBytes: 32 * GIB, inUseBytes: 0 })).toBe(4);
  });

  it("shrinks the pool as co-tenants consume the shared cgroup", () => {
    const workersAt = (inUseGib: number) =>
      workerBudget.computeWorkers({ ...base, limitBytes: 32 * GIB, inUseBytes: inUseGib * GIB });

    expect(workersAt(16)).toBe(2);
    expect(workersAt(22)).toBe(1);
  });

  it("keeps one worker even when the cgroup has no headroom left", () => {
    expect(
      workerBudget.computeWorkers({ ...base, limitBytes: 32 * GIB, inUseBytes: 32 * GIB })
    ).toBe(1);
  });

  it("never exceeds the core budget on small hosts", () => {
    expect(
      workerBudget.computeWorkers({ ...base, cpuCount: 2, limitBytes: 64 * GIB, inUseBytes: 0 })
    ).toBe(1);
  });
});

describe("eslint profile", () => {
  const eslintWorkersAt = (limitGib: number) =>
    workerBudget.computeWorkers({
      ...workerBudget.PROFILES.eslint,
      cpuCount: 8,
      limitBytes: limitGib * GIB,
      inUseBytes: 10 * GIB,
    });

  it("leaves room for a second cold lint on a 32GiB cgroup while large hosts keep 4 lanes", () => {
    expect(eslintWorkersAt(32)).toBe(2);
    expect(eslintWorkersAt(64)).toBe(4);
  });
});
