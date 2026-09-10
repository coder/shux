import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { EventStore } from "./eventStore";
import type { Config } from "@/node/config";

// Test types
interface TestState {
  id: string;
  value: number;
  items: string[];
}

interface TestEvent {
  type: "start" | "item" | "end";
  id: string;
  data?: string | number;
}

describe("EventStore", () => {
  const testSessionDir = path.join(__dirname, "../../test-sessions");
  const testWorkspaceId = "test-workspace-123";
  const testFilename = "test-state.json";

  let mockConfig: Config;
  let store: EventStore<TestState, TestEvent>;
  let emittedEvents: TestEvent[] = [];

  // Test serializer: converts state into events
  const serializeState = (state: TestState & { workspaceId?: string }): TestEvent[] => {
    const events: TestEvent[] = [];
    events.push({ type: "start", id: state.workspaceId ?? state.id, data: state.value });
    for (const item of state.items) {
      events.push({ type: "item", id: state.workspaceId ?? state.id, data: item });
    }
    events.push({ type: "end", id: state.workspaceId ?? state.id, data: state.items.length });
    return events;
  };

  // Test emitter: captures events
  const emitEvent = (event: TestEvent): void => {
    emittedEvents.push(event);
  };

  beforeEach(async () => {
    // Create test session directory
    try {
      await fs.access(testSessionDir);
    } catch {
      await fs.mkdir(testSessionDir, { recursive: true });
    }

    mockConfig = {
      muxDir: path.join(__dirname, "../.."),
      sessionsDir: testSessionDir,
    } as unknown as Config;

    emittedEvents = [];

    store = new EventStore(mockConfig, testFilename, serializeState, emitEvent, "TestStore");
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await fs.access(testSessionDir);
      await fs.rm(testSessionDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, nothing to clean up
    }
  });

  describe("State Management", () => {
    it("should store and retrieve in-memory state", () => {
      const state: TestState = { id: "test", value: 42, items: ["a", "b"] };

      store.setState(testWorkspaceId, state);
      const retrieved = store.getState(testWorkspaceId);

      expect(retrieved).toEqual(state);
    });

    it("should return undefined for non-existent state", () => {
      const retrieved = store.getState("non-existent");
      expect(retrieved).toBeUndefined();
    });

    it("should delete in-memory state", () => {
      const state: TestState = { id: "test", value: 42, items: [] };

      store.setState(testWorkspaceId, state);
      expect(store.hasState(testWorkspaceId)).toBe(true);

      store.deleteState(testWorkspaceId);
      expect(store.hasState(testWorkspaceId)).toBe(false);
      expect(store.getState(testWorkspaceId)).toBeUndefined();
    });

    it("should check if state exists", () => {
      expect(store.hasState(testWorkspaceId)).toBe(false);

      store.setState(testWorkspaceId, { id: "test", value: 1, items: [] });
      expect(store.hasState(testWorkspaceId)).toBe(true);
    });

    it("should get all active workspace IDs", () => {
      store.setState("workspace-1", { id: "1", value: 1, items: [] });
      store.setState("workspace-2", { id: "2", value: 2, items: [] });

      const ids = store.getActiveWorkspaceIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain("workspace-1");
      expect(ids).toContain("workspace-2");
    });
  });

  describe("Persistence", () => {
    it("should persist state to disk", async () => {
      const state: TestState = { id: "test", value: 99, items: ["x", "y", "z"] };

      await store.persist(testWorkspaceId, state);

      // Verify file exists
      const workspaceDir = path.join(testSessionDir, testWorkspaceId);
      const filePath = path.join(workspaceDir, testFilename);
      try {
        await fs.access(filePath);
      } catch {
        throw new Error(`File ${filePath} does not exist`);
      }

      // Verify content
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content) as TestState;
      expect(parsed).toEqual(state);
    });

    it("should read persisted state from disk", async () => {
      const state: TestState = { id: "test", value: 123, items: ["foo", "bar"] };

      await store.persist(testWorkspaceId, state);
      const retrieved = await store.readPersisted(testWorkspaceId);

      expect(retrieved).toEqual(state);
    });

    it("should return null for non-existent persisted state", async () => {
      const retrieved = await store.readPersisted("non-existent");
      expect(retrieved).toBeNull();
    });

    it("should delete persisted state from disk", async () => {
      const state: TestState = { id: "test", value: 456, items: [] };

      await store.persist(testWorkspaceId, state);
      await store.deletePersisted(testWorkspaceId);

      const retrieved = await store.readPersisted(testWorkspaceId);
      expect(retrieved).toBeNull();
    });

    it("should not throw when deleting non-existent persisted state", async () => {
      // Should complete without throwing (logs error but doesn't throw)
      await store.deletePersisted("non-existent");
      // If we get here, it didn't throw
      expect(true).toBe(true);
    });
  });

  describe("Replay", () => {
    it("should replay events from in-memory state", async () => {
      const state: TestState = { id: "mem", value: 10, items: ["a", "b", "c"] };
      store.setState(testWorkspaceId, state);

      await store.replay(testWorkspaceId, { workspaceId: testWorkspaceId });

      expect(emittedEvents).toHaveLength(5); // start + 3 items + end
      expect(emittedEvents[0]).toEqual({ type: "start", id: testWorkspaceId, data: 10 });
      expect(emittedEvents[1]).toEqual({ type: "item", id: testWorkspaceId, data: "a" });
      expect(emittedEvents[2]).toEqual({ type: "item", id: testWorkspaceId, data: "b" });
      expect(emittedEvents[3]).toEqual({ type: "item", id: testWorkspaceId, data: "c" });
      expect(emittedEvents[4]).toEqual({ type: "end", id: testWorkspaceId, data: 3 });
    });

    it("should replay events from disk state when not in memory", async () => {
      const state: TestState = { id: "disk", value: 20, items: ["x"] };

      await store.persist(testWorkspaceId, state);
      // Don't set in-memory state

      await store.replay(testWorkspaceId, { workspaceId: testWorkspaceId });

      expect(emittedEvents).toHaveLength(3); // start + 1 item + end
      expect(emittedEvents[0]).toEqual({ type: "start", id: testWorkspaceId, data: 20 });
      expect(emittedEvents[1]).toEqual({ type: "item", id: testWorkspaceId, data: "x" });
      expect(emittedEvents[2]).toEqual({ type: "end", id: testWorkspaceId, data: 1 });
    });

    it("should prefer in-memory state over disk state", async () => {
      const diskState: TestState = { id: "disk", value: 1, items: [] };
      const memState: TestState = { id: "mem", value: 2, items: [] };

      await store.persist(testWorkspaceId, diskState);
      store.setState(testWorkspaceId, memState);

      await store.replay(testWorkspaceId, { workspaceId: testWorkspaceId });

      expect(emittedEvents[0]).toEqual({ type: "start", id: testWorkspaceId, data: 2 }); // Memory value
    });

    it("should do nothing when replaying non-existent state", async () => {
      await store.replay("non-existent", { workspaceId: "non-existent" });
      expect(emittedEvents).toHaveLength(0);
    });

    it("should pass context to serializer", async () => {
      const state: TestState = { id: "original", value: 100, items: [] };
      store.setState(testWorkspaceId, state);

      await store.replay(testWorkspaceId, { workspaceId: "override-id" });

      // Serializer should use workspaceId from context
      expect(emittedEvents[0]).toEqual({ type: "start", id: "override-id", data: 100 });
    });
  });

  describe("Integration", () => {
    it("should handle full lifecycle: set → persist → delete memory → replay from disk", async () => {
      const state: TestState = { id: "lifecycle", value: 777, items: ["test"] };

      // Set in memory
      store.setState(testWorkspaceId, state);
      expect(store.hasState(testWorkspaceId)).toBe(true);

      // Persist to disk
      await store.persist(testWorkspaceId, state);

      // Clear memory
      store.deleteState(testWorkspaceId);
      expect(store.hasState(testWorkspaceId)).toBe(false);

      // Replay from disk
      await store.replay(testWorkspaceId, { workspaceId: testWorkspaceId });

      // Verify events were emitted
      expect(emittedEvents).toHaveLength(3);
      expect(emittedEvents[0].data).toBe(777);
    });
  });
});
