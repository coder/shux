import type { ORPCContext } from "@/node/orpc/context";
import { DESKTOP_WS_PATH } from "@/node/orpc/wsPaths";
import { log } from "@/node/services/log";

interface DesktopContext {
  desktopSessionManager: Pick<
    ORPCContext["desktopSessionManager"],
    "getCapability" | "ensureStarted" | "resolveTarget"
  >;
  desktopTokenManager: Pick<ORPCContext["desktopTokenManager"], "mint">;
  serverService: Pick<ORPCContext["serverService"], "getServerInfo">;
}

export async function getDesktopBootstrap(context: DesktopContext, workspaceId: string) {
  const capability = await context.desktopSessionManager.getCapability(workspaceId);
  if (!capability.available) return { capability };
  const serverInfo = context.serverService.getServerInfo();
  if (serverInfo == null) {
    log.error("Desktop bootstrap failed: API server unavailable", { workspaceId });
    return { capability: { available: false as const, reason: "startup_failed" as const } };
  }
  try {
    const session = await context.desktopSessionManager.ensureStarted(workspaceId);
    const target = context.desktopSessionManager.resolveTarget(workspaceId);
    if (target.ownerWorkspaceId !== (capability.sharedDesktop?.ownerWorkspaceId ?? workspaceId)) {
      throw new Error(`Desktop target changed during bootstrap for workspace ${workspaceId}`);
    }
    const sessionInfo = session.getSessionInfo();
    const startedCapability = {
      available: true as const,
      width: sessionInfo.width,
      height: sessionInfo.height,
      sessionId: sessionInfo.sessionId ?? capability.sessionId,
      ...(target.ownerWorkspaceId !== workspaceId ? { sharedDesktop: target } : {}),
    };
    return {
      capability: startedCapability,
      bridgePath: DESKTOP_WS_PATH,
      token: context.desktopTokenManager.mint(workspaceId, startedCapability.sessionId),
      localBridgeBaseUrl: serverInfo.baseUrl,
    };
  } catch (error) {
    log.error("Desktop bootstrap failed", { workspaceId, error });
    return { capability: { available: false as const, reason: "startup_failed" as const } };
  }
}
