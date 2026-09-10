import type { ORPCContext } from "@/node/orpc/context";
import { BROWSER_BRIDGE_WS_PATH } from "@/node/orpc/wsPaths";

type BrowserContext = Pick<
  ORPCContext,
  | "browserSessionDiscoveryService"
  | "browserBridgeTokenManager"
  | "browserControlService"
  | "browserSessionStateHub"
  | "serverService"
>;

export async function listBrowserSessions(context: BrowserContext, workspaceId: string) {
  const groups = await context.browserSessionDiscoveryService.listSessionGroups(workspaceId);
  return {
    sessions: groups.sessions.map(({ sessionName, status }) => ({ sessionName, status })),
    otherSessions: groups.otherSessions.map(({ sessionName, status, cwd }) => ({
      sessionName,
      status,
      cwd,
    })),
  };
}

export async function getBrowserBootstrap(
  context: BrowserContext,
  input: { workspaceId: string; sessionName: string; allowOtherWorkspaceSession?: boolean | null }
) {
  const serverInfo = context.serverService.getServerInfo();
  if (serverInfo == null)
    throw new Error("Browser bridge bootstrap failed: API server unavailable");
  const allowOtherWorkspaceSession = input.allowOtherWorkspaceSession === true;
  const connection = await context.browserSessionDiscoveryService.ensureSessionAttachable(
    input.workspaceId,
    input.sessionName,
    { allowOtherWorkspaceSession }
  );
  return {
    bridgePath: BROWSER_BRIDGE_WS_PATH,
    token: context.browserBridgeTokenManager.mint(
      input.workspaceId,
      connection.sessionName,
      connection.streamPort,
      { allowOtherWorkspaceSession }
    ),
    localBridgeBaseUrl: serverInfo.baseUrl,
  };
}

async function markLoaded(
  context: BrowserContext,
  workspaceId: string,
  sessionName: string,
  commandToken: number
): Promise<void> {
  try {
    const result = await context.browserControlService.getUrl(workspaceId, sessionName, {
      skipSessionValidation: true,
    });
    context.browserSessionStateHub.markLoaded(
      workspaceId,
      sessionName,
      result.error == null ? result.url : undefined,
      commandToken
    );
  } catch {
    context.browserSessionStateHub.markLoaded(workspaceId, sessionName, undefined, commandToken);
  }
}

async function runWithLoadingState<T extends { success: boolean }>(
  context: BrowserContext,
  workspaceId: string,
  sessionName: string,
  run: () => Promise<T>
): Promise<T> {
  const commandToken = context.browserSessionStateHub.markLoading(workspaceId, sessionName);
  try {
    const result = await run();
    if (result.success) await markLoaded(context, workspaceId, sessionName, commandToken);
    else
      context.browserSessionStateHub.markLoaded(workspaceId, sessionName, undefined, commandToken);
    return result;
  } catch (error) {
    await markLoaded(context, workspaceId, sessionName, commandToken);
    throw error;
  }
}

export function controlBrowser(
  context: BrowserContext,
  input: Parameters<BrowserContext["browserControlService"]["executeControl"]>[0]
) {
  return runWithLoadingState(context, input.workspaceId, input.sessionName, () =>
    context.browserControlService.executeControl(input)
  );
}

export function selectBrowserTab(
  context: BrowserContext,
  input: Parameters<BrowserContext["browserControlService"]["selectTab"]>[0]
) {
  return runWithLoadingState(context, input.workspaceId, input.sessionName, () =>
    context.browserControlService.selectTab(input)
  );
}
