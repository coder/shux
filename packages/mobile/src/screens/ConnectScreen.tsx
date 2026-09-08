import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { ArrowRight, Eye, EyeOff, ShieldCheck } from "lucide-react-native";
import type { TextInput } from "react-native";
import { connect } from "../connection";
import { isInsecureEndpoint } from "../endpoint";
import { loadCredentials, saveCredentials } from "../credentials";
import { Button, Field, IconButton, Loading, Notice } from "../components/Controls";
import { KeyboardAvoidingView } from "../components/Keyboard";
import { colors, layout, spacing, typography } from "../theme";

export type Connection = Awaited<ReturnType<typeof connect>>;

export function ConnectScreen(props: { onConnect: (connection: Connection) => void }) {
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const tokenInput = useRef<TextInput>(null);
  const [showToken, setShowToken] = useState(false);
  let insecure = false;
  try {
    insecure = isInsecureEndpoint(endpoint.trim());
  } catch {
    /* A partially entered URL is validated on connect, not while typing. */
  }

  useEffect(() => {
    let active = true;
    loadCredentials()
      .then((saved) => {
        if (!active) return;
        if (saved) {
          setEndpoint(saved.endpoint);
          setToken(saved.token);
        }
      })
      .catch(() => {
        if (active)
          setError("Saved connection could not be read. Enter your server details again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      request.current?.abort();
    };
  }, []);

  async function submit() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    let connection: Connection | undefined;
    try {
      connection = await connect(endpoint.trim(), token.trim(), { signal: controller.signal });
      if (controller.signal.aborted) {
        connection.close();
        return;
      }
      await saveCredentials({ endpoint: endpoint.trim(), token: token.trim() });
      if (controller.signal.aborted) {
        connection.close();
        return;
      }
      request.current = null;
      props.onConnect(connection);
    } catch (cause) {
      connection?.close();
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not connect. Check the server URL and token."
        );
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <KeyboardAvoidingView
      style={layout.fill}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.form}>
          <View style={{ gap: spacing.sm }}>
            <Text style={styles.wordmark}>
              xum<Text style={{ color: colors.accent }}>.</Text>
            </Text>
            <Text style={layout.title}>Connect to Xum</Text>
            <Text style={layout.muted}>Enter the address of your Xum server.</Text>
          </View>
          {loading ? (
            <Loading label="Reading saved connection…" />
          ) : (
            <>
              <View style={styles.fields}>
                <Field
                  label="Server URL"
                  placeholder="https://xum.example.com"
                  value={endpoint}
                  onChangeText={setEndpoint}
                  keyboardType="url"
                  editable={!busy}
                  autoComplete="url"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => tokenInput.current?.focus()}
                />
                <Field
                  ref={tokenInput}
                  label="Bearer token"
                  placeholder="Server authentication token"
                  value={token}
                  onChangeText={setToken}
                  secureTextEntry={!showToken}
                  editable={!busy}
                  autoComplete="off"
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    // HTTP requires the explicitly labelled button, not a keyboard shortcut.
                    if (!insecure && endpoint.trim() && token.trim()) return submit();
                  }}
                  trailing={
                    <IconButton
                      label={showToken ? "Hide bearer token" : "Show bearer token"}
                      icon={showToken ? EyeOff : Eye}
                      onPress={() => setShowToken(!showToken)}
                      disabled={busy}
                    />
                  }
                />
              </View>
              {insecure && (
                <Notice severity="warning">
                  HTTP is not encrypted. Use loopback HTTP only for development on this device.
                  Connections to other devices require HTTPS.
                </Notice>
              )}
              {error && <Notice>{error}</Notice>}
              <Button
                icon={ArrowRight}
                busy={busy}
                disabled={!endpoint.trim() || !token.trim()}
                onPress={submit}
              >
                {insecure ? "Connect without encryption" : "Connect"}
              </Button>
            </>
          )}
          {/* The web build previews native UX; storage differences belong in developer docs. */}
          <View style={[layout.row, { alignItems: "flex-start" }]}>
            <ShieldCheck color={colors.muted} size={16} />
            <Text style={[typography.footnote, { color: colors.muted, flex: 1 }]}>
              Your token authenticates this app with your Xum server.
            </Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: spacing.xl, paddingTop: spacing.xxxl },
  form: { gap: spacing.xxl, maxWidth: 480, width: "100%", alignSelf: "center" },
  wordmark: {
    color: colors.bright,
    fontSize: 28,
    lineHeight: 36,
    fontWeight: "700",
    letterSpacing: -1,
    marginBottom: spacing.lg,
  },
  fields: { gap: spacing.xl },
});
