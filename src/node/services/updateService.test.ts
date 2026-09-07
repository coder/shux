import { describe, it, expect, mock } from "bun:test";
import type { Config } from "@/node/config";
import type { UpdateChannel } from "@/common/types/project";
import { UpdateService } from "./updateService";

function createMockConfig(initialChannel: UpdateChannel) {
  const state: { channel: UpdateChannel } = { channel: initialChannel };
  const getUpdateChannel = mock(() => state.channel);
  const setUpdateChannel = mock((channel: UpdateChannel) => {
    state.channel = channel;
    return Promise.resolve();
  });

  return {
    config: {
      getUpdateChannel,
      setUpdateChannel,
    } as unknown as Config,
    getUpdateChannel,
    setUpdateChannel,
  };
}

describe("UpdateService channel persistence", () => {
  it("reads persisted channel from config during startup", () => {
    const { config, getUpdateChannel } = createMockConfig("nightly");

    const service = new UpdateService(config);

    expect(getUpdateChannel).toHaveBeenCalledTimes(1);
    expect(service.getChannel()).toBe("nightly");
    expect(getUpdateChannel).toHaveBeenCalledTimes(1);
  });

  it("persists channel changes via config service", async () => {
    const { config, setUpdateChannel } = createMockConfig("stable");

    const service = new UpdateService(config);

    await service.setChannel("nightly");
    expect(setUpdateChannel).toHaveBeenCalledWith("nightly");
    expect(service.getChannel()).toBe("nightly");

    await service.setChannel("stable");
    expect(setUpdateChannel).toHaveBeenLastCalledWith("stable");
    expect(service.getChannel()).toBe("stable");
  });

  it("offers npm only on the server and rejects unsupported changes before persistence", async () => {
    const { config, setUpdateChannel } = createMockConfig("stable");
    const service = new UpdateService(config);
    expect(service.getSupportedChannels()).toContain("npm");
    await service.setChannel("npm");
    expect(service.getChannel()).toBe("npm");
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
    try {
      Object.defineProperty(process.versions, "electron", { configurable: true, value: "test" });
      expect(service.getSupportedChannels()).not.toContain("npm");
      expect(service.getChannel()).toBe("stable");
      setUpdateChannel.mockClear();
      const error = await service.setChannel("npm").then(
        () => null,
        (error: unknown) => error
      );
      expect(error).toBeInstanceOf(Error);
      expect(setUpdateChannel).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(process.versions, "electron", descriptor);
      else Reflect.deleteProperty(process.versions, "electron");
    }
  });

  it("leaves the runtime untouched when persistence fails", async () => {
    const { config, setUpdateChannel } = createMockConfig("stable");
    setUpdateChannel.mockRejectedValueOnce(new Error("disk full"));
    const service = new UpdateService(config);
    const channels: UpdateChannel[] = [];
    const internal = service as unknown as {
      impl: { setChannel(channel: UpdateChannel): void; getChannel(): UpdateChannel };
      currentStatus: { type: string };
    };
    internal.impl = {
      setChannel: (channel) => channels.push(channel),
      getChannel: () => channels.at(-1) ?? "stable",
    };
    internal.currentStatus = { type: "idle" };
    let failed = false;
    try {
      await service.setChannel("nightly");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(channels).toEqual([]);
    expect(service.getChannel()).toBe("stable");
  });

  it("reverts the persisted channel when the runtime refuses the switch", async () => {
    const { config, setUpdateChannel } = createMockConfig("stable");
    const service = new UpdateService(config);
    const internal = service as unknown as {
      impl: { setChannel(channel: UpdateChannel): void; getChannel(): UpdateChannel };
      currentStatus: { type: string };
    };
    internal.impl = {
      setChannel: () => {
        throw new Error("An update operation is in progress");
      },
      getChannel: () => "stable",
    };
    internal.currentStatus = { type: "downloading" };
    let failed = false;
    try {
      await service.setChannel("nightly");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(setUpdateChannel.mock.calls.map((call) => call[0])).toEqual(["nightly", "stable"]);
    expect(service.getChannel()).toBe("stable");
  });

  it("persists the channel while the updater reports an unsupported layout", async () => {
    const { config, setUpdateChannel } = createMockConfig("stable");
    const service = new UpdateService(config);
    const channels: UpdateChannel[] = [];
    const internal = service as unknown as {
      impl: { setChannel(channel: UpdateChannel): void; getChannel(): UpdateChannel };
      currentStatus: { type: string };
    };
    internal.impl = {
      setChannel: (channel) => channels.push(channel),
      getChannel: () => channels.at(-1) ?? "stable",
    };
    internal.currentStatus = { type: "unsupported" };
    await service.setChannel("nightly");
    expect(setUpdateChannel).toHaveBeenLastCalledWith("nightly");
    expect(service.getChannel()).toBe("nightly");
  });

  it("serializes concurrent changes so a rollback cannot land after a later switch", async () => {
    const { config, setUpdateChannel, getUpdateChannel } = createMockConfig("stable");
    // Config writes complete in order but asynchronously, like the real FIFO editor.
    let queue = Promise.resolve();
    setUpdateChannel.mockImplementation((channel) => {
      queue = queue.then(() => new Promise((resolve) => setTimeout(resolve, 1)));
      return queue.then(() => {
        getUpdateChannel.mockReturnValue(channel);
      });
    });
    const service = new UpdateService(config);
    const channels: UpdateChannel[] = [];
    const internal = service as unknown as {
      impl: { setChannel(channel: UpdateChannel): void; getChannel(): UpdateChannel };
      currentStatus: { type: string };
    };
    let refusals = 1;
    internal.impl = {
      setChannel: (channel) => {
        if (refusals-- > 0) throw new Error("An update operation is in progress");
        channels.push(channel);
      },
      getChannel: () => channels.at(-1) ?? "stable",
    };
    internal.currentStatus = { type: "idle" };
    const [first, second] = await Promise.allSettled([
      service.setChannel("nightly"),
      service.setChannel("nightly"),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
    expect(setUpdateChannel.mock.calls.map((call) => call[0])).toEqual([
      "nightly",
      "stable",
      "nightly",
    ]);
    expect(getUpdateChannel()).toBe("nightly");
    expect(service.getChannel()).toBe("nightly");
  });
});
