import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronRight, KeyRound, LogOut, Server, ShieldCheck } from "lucide-react-native";
import { Button, Header, Notice, Sheet } from "../components/Controls";
import { colors, layout, spacing, typography } from "../theme";

export function SettingsScreen(props: {
  endpoint: string;
  onDisconnect: () => void;
  onBack: () => void;
  error: string | null;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={layout.fill}>
      <Header title="Settings" onBack={props.onBack} />
      <ScrollView contentContainerStyle={layout.content}>
        <View style={styles.section}>
          <Text style={layout.label}>Connection</Text>
          <View style={layout.group}>
            <View style={styles.row}>
              <Server size={20} color={colors.accent} />
              <View style={styles.rowText}>
                <Text style={layout.text}>Xum server</Text>
                <Text selectable style={styles.footnote}>
                  {props.endpoint}
                </Text>
              </View>
            </View>
            <View style={styles.separator} />
            <View style={styles.row}>
              <ShieldCheck size={20} color={colors.muted} />
              <View style={styles.rowText}>
                <Text style={layout.text}>
                  {Platform.OS === "web" ? "This tab only" : "Secure device storage"}
                </Text>
                <Text style={styles.footnote}>
                  {Platform.OS === "web"
                    ? "Your token is never saved in browser storage."
                    : "Your token is kept in the device’s credential store."}
                </Text>
              </View>
            </View>
          </View>
        </View>
        <View style={styles.section}>
          <Text style={layout.label}>Workspace</Text>
          <View style={layout.group}>
            <View style={styles.row}>
              <Server size={20} color={colors.muted} />
              <View style={styles.rowText}>
                <Text style={layout.text}>Runs on your server</Text>
                <Text style={styles.footnote}>
                  Agents, files, and commands stay on your connected Xum server.
                </Text>
              </View>
            </View>
            <View style={styles.separator} />
            <View style={styles.row}>
              <KeyRound size={20} color={colors.muted} />
              <View style={styles.rowText}>
                <Text style={layout.text}>Managed on desktop</Text>
                <Text style={styles.footnote}>
                  Providers, runtimes, terminals, and project setup. Attachments are read-only here.
                </Text>
              </View>
            </View>
          </View>
        </View>
        {props.error && !confirming && <Notice>{props.error}</Notice>}
        <View style={styles.section}>
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            onPress={() => setConfirming(true)}
            style={[layout.group, styles.row]}
          >
            <LogOut size={20} color={colors.danger} />
            <Text style={[layout.text, { color: colors.danger, flex: 1 }]}>Disconnect</Text>
            <ChevronRight size={18} color={colors.muted} />
          </Pressable>
          <Text style={styles.footnote}>Disconnecting leaves your agents running.</Text>
        </View>
      </ScrollView>
      {confirming && (
        <Sheet
          title="Disconnect from Xum?"
          onClose={() => setConfirming(false)}
          dismissDisabled={props.busy}
          footer={
            <>
              <Button destructive icon={LogOut} busy={props.busy} onPress={props.onDisconnect}>
                Disconnect & forget credentials
              </Button>
              <Button secondary disabled={props.busy} onPress={() => setConfirming(false)}>
                Keep connection
              </Button>
            </>
          }
        >
          <Text style={layout.text}>
            This removes the saved connection from this device. You’ll need your server URL and
            token to reconnect.
          </Text>
          <Text style={layout.muted}>Your workspaces and running agents are not affected.</Text>
          {props.error && <Notice>{props.error}</Notice>}
        </Sheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  row: {
    minHeight: 56,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  rowText: { flex: 1, minWidth: 0, gap: spacing.xs },
  footnote: { ...typography.footnote, color: colors.muted },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 48, backgroundColor: colors.border },
});
