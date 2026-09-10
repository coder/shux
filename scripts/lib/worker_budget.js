"use strict";

// Size tool worker pools against the tightest cgroup memory cap, including ancestor caps that
// Node's leaf-only constrainedMemory() check can miss.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BYTES_PER_GIB = 1024 ** 3;
const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";
const DEFAULT_PROC_SELF_CGROUP = "/proc/self/cgroup";

// cgroup v1 spells "unlimited" as a saturated integer rather than "max", so treat implausibly large
// caps as absent instead of trusting them.
const UNLIMITED_BYTES_FLOOR = 2n ** 62n;

// Peak RSS measured per worker in this repo, rounded up for growth. Cold type-aware ESLint runs at
// --concurrency 4 measured 14.3 and 15.4GiB RSS (3.6 to 3.9GiB per lane); 8GiB per lane keeps one
// cold lint on a 32GiB cgroup at 2 lanes, leaving room for another workspace. Jest forks: ~4.7GiB.
const PROFILES = {
  eslint: { memoryPerWorkerGib: 8, maxWorkers: 4 },
  jest: { memoryPerWorkerGib: 6, maxWorkers: 4 },
};

const CPU_FRACTION = 0.5;

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseBytes(raw) {
  if (raw == null) {
    return null;
  }
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  let value;
  try {
    value = BigInt(text);
  } catch {
    return null;
  }
  if (value < 0n) {
    return null;
  }
  return value;
}

function parseLimitBytes(raw) {
  const value = parseBytes(raw);
  if (value == null || value === 0n || value >= UNLIMITED_BYTES_FLOOR) {
    return null;
  }
  return Number(value);
}

function dirChain(root, cgroupPath) {
  const segments = cgroupPath.split("/").filter(Boolean);
  const chain = [];
  for (let depth = segments.length; depth >= 0; depth--) {
    chain.push(path.join(root, ...segments.slice(0, depth)));
  }
  return chain;
}

function cgroupMembership(options) {
  const raw = readFileOrNull(options.procSelfCgroup ?? DEFAULT_PROC_SELF_CGROUP);
  let v2Path = null;
  let v1MemoryPath = null;

  for (const line of raw?.split("\n") ?? []) {
    const match = line.trim().match(/^\d+:([^:]*):(.*)$/);
    if (match == null) {
      continue;
    }
    const controllers = match[1].split(",");
    if (controllers.length === 1 && controllers[0] === "") {
      v2Path = match[2];
    } else if (controllers.includes("memory")) {
      v1MemoryPath = match[2];
    }
  }

  return { v2Path, v1MemoryPath };
}

// Keep the constraining directory so its ancestor-level co-tenant usage can be subtracted.
function tightestConstraint(dirs, limitFile) {
  let constraint = null;
  for (const dir of dirs) {
    const limitBytes = parseLimitBytes(readFileOrNull(path.join(dir, limitFile)));
    if (limitBytes != null && (constraint == null || limitBytes <= constraint.limitBytes)) {
      constraint = { dir, limitBytes };
    }
  }
  return constraint;
}

function resolveMemoryConstraint(options = {}) {
  const cgroupRoot = options.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const membership = cgroupMembership(options);
  if (membership.v2Path != null) {
    const constraint = tightestConstraint(dirChain(cgroupRoot, membership.v2Path), "memory.max");
    if (constraint != null) {
      return constraint;
    }
  }

  if (membership.v1MemoryPath == null) {
    return null;
  }
  return tightestConstraint(
    dirChain(path.join(cgroupRoot, "memory"), membership.v1MemoryPath),
    "memory.limit_in_bytes"
  );
}

function parseMemoryStat(dir) {
  const raw = readFileOrNull(path.join(dir, "memory.stat"));
  if (raw == null) {
    return null;
  }

  const values = new Map();
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    const parsed = parseBytes(value);
    if (key && parsed != null) {
      values.set(key, Number(parsed));
    }
  }
  return values;
}

// Discount inactive file cache, but use the v2 resident-memory fields as a floor when available.
function readCgroupUsageBytes(dir) {
  const stat = parseMemoryStat(dir);
  const current = parseBytes(readFileOrNull(path.join(dir, "memory.current")));
  if (current != null) {
    if (stat == null) {
      return Number(current);
    }
    const resident =
      (stat.get("anon") ?? 0) +
      (stat.get("kernel") ?? stat.get("slab") ?? 0) +
      (stat.get("shmem") ?? 0);
    const inactiveFile = stat.get("inactive_file");
    return inactiveFile == null ? resident : Math.max(resident, Number(current) - inactiveFile);
  }

  const usage = parseBytes(readFileOrNull(path.join(dir, "memory.usage_in_bytes")));
  if (usage == null) {
    return null;
  }
  const inactiveFile = stat?.get("total_inactive_file") ?? stat?.get("inactive_file");
  return inactiveFile == null ? Number(usage) : Math.max(0, Number(usage) - inactiveFile);
}

function computeWorkers(input) {
  const cpuWorkers = Math.max(1, Math.floor(input.cpuCount * CPU_FRACTION));

  // Preserve headroom for the parent process, active file cache, and co-tenants growing mid-run.
  const reserveBytes = Math.max(2 * BYTES_PER_GIB, input.limitBytes * 0.15);
  const usableBytes = Math.max(0, input.limitBytes - input.inUseBytes - reserveBytes);
  const memoryWorkers = Math.floor(usableBytes / (input.memoryPerWorkerGib * BYTES_PER_GIB));

  return Math.max(1, Math.min(cpuWorkers, memoryWorkers, input.maxWorkers));
}

function resolveWorkerBudget(profileName, options = {}) {
  const profile = PROFILES[profileName];
  if (profile == null) {
    throw new Error(
      `unknown worker budget profile "${profileName}" (expected one of: ${Object.keys(PROFILES).join(", ")})`
    );
  }

  const constraint = resolveMemoryConstraint(options);
  // Without a cgroup cap there is no bounded co-tenant usage signal. Host free-memory swings would
  // make a busy laptop silently serialize its own test run.
  const limitBytes = constraint?.limitBytes ?? os.totalmem();
  const inUseBytes = constraint == null ? 0 : (readCgroupUsageBytes(constraint.dir) ?? 0);

  const input = {
    ...profile,
    cpuCount: os.availableParallelism?.() ?? os.cpus().length,
    limitBytes,
    inUseBytes,
  };
  return { ...input, cgroupDir: constraint?.dir ?? null, workers: computeWorkers(input) };
}

function formatWorkerBudget(budget) {
  const gib = (bytes) => `${(bytes / BYTES_PER_GIB).toFixed(1)}GiB`;
  return [
    `workers=${budget.workers}`,
    `limit=${gib(budget.limitBytes)}`,
    `inUse=${gib(budget.inUseBytes)}`,
    `perWorker=${budget.memoryPerWorkerGib}GiB`,
    `cpus=${budget.cpuCount}`,
    `cgroup=${budget.cgroupDir ?? "none"}`,
  ].join(" ");
}

function workerBudgetFor(profileName) {
  const budget = resolveWorkerBudget(profileName);
  if (process.env.MUX_WORKER_BUDGET_DEBUG) {
    process.stderr.write(`[worker-budget] ${profileName} ${formatWorkerBudget(budget)}\n`);
  }
  return budget.workers;
}

module.exports = {
  PROFILES,
  computeWorkers,
  readCgroupUsageBytes,
  resolveMemoryConstraint,
  workerBudgetFor,
};

if (require.main === module) {
  const profileName = process.argv[2];
  const budget = resolveWorkerBudget(profileName);
  if (process.argv.includes("--debug") || process.env.MUX_WORKER_BUDGET_DEBUG) {
    process.stderr.write(`[worker-budget] ${profileName} ${formatWorkerBudget(budget)}\n`);
  }
  process.stdout.write(`${budget.workers}\n`);
}
