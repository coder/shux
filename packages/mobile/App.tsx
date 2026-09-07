import { createContext, useContext, useState } from "react";
import type { ReactNode, SetStateAction } from "react";
import { StatusBar, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { FrontendWorkspaceMetadata } from "../../src/common/types/workspace";
import { clearCredentials } from "./src/credentials";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import type { Connection } from "./src/screens/ConnectScreen";
import { Navigator } from "./src/screens/Navigator";
import { ConversationScreen } from "./src/screens/ConversationScreen";
import { CreateWorkspace } from "./src/screens/CreateWorkspace";
import { ChangesScreen } from "./src/screens/ChangesScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { Button, Header, Loading, Notice } from "./src/components/Controls";
import { KeyboardProvider } from "./src/components/Keyboard";
import { useProjects } from "./src/useProjects";
import { useConnection } from "./src/useConnection";
import { colors, layout, WIDE_LAYOUT_MIN_WIDTH } from "./src/theme";
import type { ChatSettings } from "./src/settings";

export type MobileRoutes = {
  Workspaces: undefined;
  Conversation: { workspaceId: string };
  Changes: { workspaceId: string };
  Settings: undefined;
};
const Stack = createNativeStackNavigator<MobileRoutes>();

type SessionContext = {
  session: ReturnType<typeof useConnection>;
  data: ReturnType<typeof useProjects>;
  drafts: Record<string, string>;
  selections: Record<string, ChatSettings>;
  setSelection: (id: string, value: ChatSettings) => void;
  setDraft: (id: string, update: SetStateAction<string>) => void;
  create: (onCreated: (workspace: FrontendWorkspaceMetadata) => void) => void;
  disconnect: () => Promise<void>;
  disconnectError: string | null;
  disconnecting: boolean;
};
const Session = createContext<SessionContext | null>(null);
function useSession() {
  const session = useContext(Session);
  if (!session) throw new Error("Mobile screens require an authenticated session");
  return session;
}

export default function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        {connection ? (
          <ConnectedApp connection={connection} onDisconnect={() => setConnection(null)} />
        ) : (
          <SafeAreaView style={layout.fill}>
            <ConnectScreen onConnect={setConnection} />
          </SafeAreaView>
        )}
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

function ConnectedApp(props: { connection: Connection; onDisconnect: () => void }) {
  const session = useConnection(props.connection);
  const data = useProjects(session.connection.client, session.signal);
  // Draft text and unsent model choices survive native back/pop and reconnection.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selections, setSelections] = useState<Record<string, ChatSettings>>({});
  const [onCreated, setOnCreated] = useState<
    ((workspace: FrontendWorkspaceMetadata) => void) | null
  >(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  async function disconnect() {
    session.cancel();
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await clearCredentials();
      props.onDisconnect();
    } catch {
      setDisconnectError("Could not clear saved credentials. Try disconnecting again.");
      setDisconnecting(false);
    }
  }
  const value: SessionContext = {
    session,
    data,
    drafts,
    selections,
    setSelection(id, settings) {
      setSelections((current) => ({ ...current, [id]: settings }));
    },
    disconnect,
    disconnectError,
    disconnecting,
    setDraft(id, update) {
      setDrafts((current) => {
        const next = typeof update === "function" ? update(current[id] ?? "") : update;
        return current[id] === next ? current : { ...current, [id]: next };
      });
    },
    create(callback) {
      if (session.ready) setOnCreated(() => callback);
    },
  };
  return (
    <Session.Provider value={value}>
      <NavigationContainer
        theme={{
          ...DarkTheme,
          colors: {
            ...DarkTheme.colors,
            primary: colors.accent,
            background: colors.background,
            card: colors.background,
            text: colors.bright,
            border: colors.border,
          },
        }}
      >
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
            gestureEnabled: true,
          }}
        >
          <Stack.Screen name="Workspaces" component={WorkspacesRoute} />
          <Stack.Screen
            name="Conversation"
            component={ConversationRoute}
            getId={({ params }) => params.workspaceId}
          />
          <Stack.Screen name="Changes" component={ChangesRoute} />
          <Stack.Screen name="Settings" component={SettingsRoute} />
        </Stack.Navigator>
      </NavigationContainer>
      {onCreated && (
        <CreateWorkspace
          client={session.connection.client}
          projects={data.projects}
          signal={session.signal}
          connected={session.ready}
          onReconnect={session.reconnect}
          onClose={() => setOnCreated(null)}
          onCreated={(workspace) => {
            // Navigation can render immediately; use the server-returned metadata before re-listing.
            data.addWorkspace(workspace);
            data.retry();
            onCreated(workspace);
            setOnCreated(null);
          }}
        />
      )}
    </Session.Provider>
  );
}

function WorkspaceList(props: {
  selectedId?: string;
  onSelect: (id: string) => void;
  onSettings: () => void;
  compact?: boolean;
}) {
  const { data, session, create } = useSession();
  return (
    <Navigator
      {...data}
      compact={props.compact}
      selectedId={props.selectedId}
      loading={data.loading || session.reconnecting}
      error={session.error ?? data.error}
      onRetry={session.reconnect}
      onSelect={(workspace) => props.onSelect(workspace.id)}
      onCreate={() => create((workspace) => props.onSelect(workspace.id))}
      onSettings={props.onSettings}
    />
  );
}

function WorkspacesRoute(props: NativeStackScreenProps<MobileRoutes, "Workspaces">) {
  return (
    <SafeAreaView style={layout.fill}>
      <WorkspaceList
        onSelect={(workspaceId) => props.navigation.navigate("Conversation", { workspaceId })}
        onSettings={() => props.navigation.navigate("Settings")}
      />
    </SafeAreaView>
  );
}

function ScreenLayout(props: {
  children: ReactNode;
  workspaceId?: string;
  navigation: Pick<NativeStackScreenProps<MobileRoutes>["navigation"], "navigate">;
}) {
  const { width } = useWindowDimensions();
  return (
    <SafeAreaView style={[layout.fill, { flexDirection: "row" }]}>
      {width >= WIDE_LAYOUT_MIN_WIDTH && (
        <View style={{ width: 300, borderRightWidth: 1, borderRightColor: colors.border }}>
          <WorkspaceList
            compact
            selectedId={props.workspaceId}
            onSelect={(workspaceId) => props.navigation.navigate("Conversation", { workspaceId })}
            onSettings={() => props.navigation.navigate("Settings")}
          />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
    </SafeAreaView>
  );
}

function ConversationRoute(props: NativeStackScreenProps<MobileRoutes, "Conversation">) {
  const { session, data, drafts, setDraft, selections, setSelection } = useSession();
  const { workspaceId } = props.route.params;
  const workspace = data.workspaces.find((item) => item.id === workspaceId);
  return (
    <ScreenLayout navigation={props.navigation} workspaceId={workspaceId}>
      {session.reconnecting && <Loading label="Reconnecting…" />}
      {session.error && <Notice onRetry={session.reconnect}>{session.error}</Notice>}
      {workspace ? (
        <ConversationScreen
          key={workspaceId}
          client={session.connection.client}
          serverLabel={new URL(session.connection.endpoint).host}
          workspace={workspace}
          signal={session.signal}
          connected={session.ready}
          onReconnect={session.reconnect}
          onBack={() => props.navigation.popTo("Workspaces")}
          onChanges={() => props.navigation.navigate("Changes", { workspaceId })}
          onSettings={() => props.navigation.navigate("Settings")}
          selection={selections[workspaceId] ?? null}
          onSelectionChange={(value) => setSelection(workspaceId, value)}
          draft={drafts[workspaceId] ?? ""}
          onDraftChange={(update) => setDraft(workspaceId, update)}
        />
      ) : (
        <>
          <Header title="Conversation" onBack={() => props.navigation.goBack()} />
          {data.loading ? (
            <Loading label="Opening workspace…" />
          ) : (
            <View style={layout.content}>
              <Text style={layout.text}>This workspace is no longer available.</Text>
              <Button secondary onPress={() => props.navigation.popTo("Workspaces")}>
                Back to workspaces
              </Button>
            </View>
          )}
        </>
      )}
    </ScreenLayout>
  );
}

function ChangesRoute(props: NativeStackScreenProps<MobileRoutes, "Changes">) {
  const { session } = useSession();
  return (
    <ScreenLayout navigation={props.navigation} workspaceId={props.route.params.workspaceId}>
      <ChangesScreen
        client={session.connection.client}
        workspaceId={props.route.params.workspaceId}
        signal={session.signal}
        onReconnect={session.reconnect}
        onBack={() => props.navigation.goBack()}
      />
    </ScreenLayout>
  );
}

function SettingsRoute(props: NativeStackScreenProps<MobileRoutes, "Settings">) {
  const { session, disconnect, disconnectError, disconnecting } = useSession();
  return (
    <ScreenLayout navigation={props.navigation}>
      <SettingsScreen
        endpoint={session.connection.endpoint}
        onDisconnect={disconnect}
        onBack={() => props.navigation.goBack()}
        error={disconnectError}
        busy={disconnecting}
      />
    </ScreenLayout>
  );
}
