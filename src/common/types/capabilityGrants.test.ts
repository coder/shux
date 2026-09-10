import { describe, expect, test } from "bun:test";
import type { Tool } from "ai";
import { z } from "zod";
import {
  FULL_GRANTS,
  LEAST_PRIVILEGE_GRANTS,
  isBridgeToolGranted,
  resolveCapabilityGrants,
  type CapabilityGrants,
} from "./capabilityGrants";
import { applyCapabilityGrants } from "@/common/utils/tools/capabilityGrants";

function makeTool(): Tool {
  return {
    description: "t",
    inputSchema: z.object({}),
    execute: () => Promise.resolve({}),
  };
}

describe("capability grants", () => {
  test("session scope resolves to full grants; project scope to least privilege", () => {
    expect(resolveCapabilityGrants({ scope: "session" })).toEqual(FULL_GRANTS);
    expect(resolveCapabilityGrants({ scope: "project" })).toEqual(LEAST_PRIVILEGE_GRANTS);
  });

  test("isBridgeToolGranted honors allow-all and allow-lists", () => {
    expect(isBridgeToolGranted(FULL_GRANTS, "bash")).toBe(true);
    expect(isBridgeToolGranted(LEAST_PRIVILEGE_GRANTS, "bash")).toBe(false);

    const narrow: CapabilityGrants = {
      version: 1,
      bridgeTools: { allow: ["file_read"] },
      vars: false,
      hostEvents: false,
    };
    expect(isBridgeToolGranted(narrow, "file_read")).toBe(true);
    expect(isBridgeToolGranted(narrow, "bash")).toBe(false);
  });

  test("applyCapabilityGrants filters assembled tools (grant/deny branches)", () => {
    const tools = { file_read: makeTool(), bash: makeTool(), web_fetch: makeTool() };

    // Allow-all passes through untouched (same reference: zero-cost ceiling).
    expect(applyCapabilityGrants(tools, FULL_GRANTS)).toBe(tools);

    const narrow: CapabilityGrants = {
      version: 1,
      bridgeTools: { allow: ["file_read", "web_fetch"] },
      vars: false,
      hostEvents: false,
    };
    expect(Object.keys(applyCapabilityGrants(tools, narrow)).sort()).toEqual([
      "file_read",
      "web_fetch",
    ]);

    // Least privilege denies everything.
    expect(Object.keys(applyCapabilityGrants(tools, LEAST_PRIVILEGE_GRANTS))).toEqual([]);
  });
});
