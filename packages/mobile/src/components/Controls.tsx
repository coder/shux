import { forwardRef } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { TextInputProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AlertCircle, ChevronLeft, Info, TriangleAlert, X } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { KeyboardAvoidingView } from "./Keyboard";
import { colors, layout, radii, spacing, typography } from "../theme";

export function IconButton(props: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  color?: string;
}) {
  const Icon = props.icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Icon size={22} color={props.disabled ? colors.dim : (props.color ?? colors.muted)} />
    </Pressable>
  );
}

export function Button(props: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondary?: boolean;
  destructive?: boolean;
  icon?: LucideIcon;
}) {
  const Icon = props.icon;
  const disabled = props.disabled || props.busy;
  const foreground = props.disabled
    ? colors.muted
    : props.destructive
      ? colors.danger
      : props.secondary
        ? colors.bright
        : colors.background;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: props.busy }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.secondary && styles.secondary,
        props.destructive && styles.destructive,
        props.disabled && styles.secondary,
        pressed && styles.pressed,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={foreground} size="small" />
      ) : Icon ? (
        <Icon size={18} color={foreground} />
      ) : null}
      <Text style={[styles.buttonText, { color: foreground }]}>{props.children}</Text>
    </Pressable>
  );
}

export const Field = forwardRef<
  TextInput,
  TextInputProps & { label: string; trailing?: ReactNode }
>(function Field(props, ref) {
  const { label, trailing, ...inputProps } = props;
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={layout.label}>{label}</Text>
      <View style={styles.field}>
        <TextInput
          ref={ref}
          placeholderTextColor={colors.dim}
          selectionColor={colors.accent}
          autoCapitalize="none"
          autoCorrect={false}
          {...inputProps}
          accessibilityLabel={inputProps.accessibilityLabel ?? label}
          style={[styles.input, inputProps.style]}
        />
        {trailing}
      </View>
    </View>
  );
});

export function Notice(props: {
  children: string;
  onRetry?: () => void;
  severity?: "error" | "warning" | "info";
}) {
  const severity = props.severity ?? "error";
  const Icon = severity === "warning" ? TriangleAlert : severity === "info" ? Info : AlertCircle;
  const tint =
    severity === "warning" ? colors.warning : severity === "info" ? colors.muted : colors.danger;
  return (
    <View
      accessibilityRole={severity === "info" ? undefined : "alert"}
      style={[
        styles.notice,
        severity === "warning" && { backgroundColor: colors.warningSurface },
        severity === "error" && { backgroundColor: colors.dangerSurface },
      ]}
    >
      <View style={[layout.row, { alignItems: "flex-start" }]}>
        <Icon size={18} color={tint} />
        <Text selectable style={[typography.footnote, { color: tint, flex: 1 }]}>
          {props.children}
        </Text>
      </View>
      {props.onRetry && (
        <Button secondary onPress={props.onRetry}>
          Retry
        </Button>
      )}
    </View>
  );
}

export function Loading(props: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} />
      <Text style={layout.muted}>{props.label ?? "Loading…"}</Text>
    </View>
  );
}

export function Header(props: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      {props.onBack ? (
        <IconButton label="Back" icon={ChevronLeft} onPress={props.onBack} />
      ) : (
        <View style={{ width: 44 }} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {props.title}
        </Text>
        {props.subtitle && (
          <Text numberOfLines={1} style={[typography.footnote, { color: colors.muted }]}>
            {props.subtitle}
          </Text>
        )}
      </View>
      {props.trailing ?? <View style={{ width: 44 }} />}
    </View>
  );
}

export function Sheet(props: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  variant?: "picker";
  action?: ReactNode;
  dismissDisabled?: boolean;
  onBack?: () => void;
}) {
  function dismiss() {
    if (!props.dismissDisabled) props.onClose();
  }
  const web = Platform.OS === "web";
  const picker = props.variant === "picker";
  return (
    <Modal
      animationType="slide"
      transparent={web}
      presentationStyle={web ? "overFullScreen" : "pageSheet"}
      allowSwipeDismissal={!props.dismissDisabled}
      onRequestClose={dismiss}
    >
      <View style={web ? [styles.webOverlay, picker && styles.pickerOverlay] : layout.fill}>
        {web && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Dismiss ${props.title}`}
            disabled={props.dismissDisabled}
            onPress={dismiss}
            style={styles.scrim}
          />
        )}
        <SafeAreaView
          style={
            web
              ? [styles.webSheet, picker && styles.pickerSheet]
              : [layout.fill, picker && { backgroundColor: colors.sheet }]
          }
          edges={
            web || Platform.OS === "ios"
              ? ["left", "right", "bottom"]
              : ["top", "left", "right", "bottom"]
          }
        >
          <KeyboardAvoidingView
            style={styles.sheetContent}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            {picker ? (
              <>
                {/* Native presentation owns swipe dismissal; the web preview shows its visual cue only. */}
                <View accessible={false} style={styles.grabber} />
                <View style={styles.pickerHeader}>
                  <View style={styles.pickerClose}>
                    <IconButton
                      label={props.onBack ? "Back" : "Close"}
                      icon={props.onBack ? ChevronLeft : X}
                      onPress={props.onBack ?? dismiss}
                      disabled={props.dismissDisabled}
                    />
                  </View>
                  <Text accessibilityRole="header" numberOfLines={1} style={styles.pickerTitle}>
                    {props.title}
                  </Text>
                  <View style={{ minWidth: 44 }}>{props.action}</View>
                </View>
              </>
            ) : (
              <Header
                title={props.title}
                onBack={props.onBack}
                trailing={
                  <IconButton
                    label="Close"
                    icon={X}
                    onPress={dismiss}
                    disabled={props.dismissDisabled}
                  />
                }
              />
            )}
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={[layout.content, picker && styles.pickerContent]}
            >
              {props.children}
            </ScrollView>
            {props.footer && <View style={styles.footer}>{props.footer}</View>}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
  },
  pressed: { opacity: 0.7 },
  button: {
    minHeight: 50,
    borderRadius: radii.control,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.accent,
  },
  secondary: { backgroundColor: colors.elevated },
  destructive: { backgroundColor: colors.dangerSurface },
  buttonText: { ...typography.header, textAlign: "center" },
  field: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.elevated,
    borderRadius: radii.control,
    paddingRight: spacing.xs,
  },
  input: {
    ...typography.body,
    color: colors.bright,
    minWidth: 0,
    flex: 1,
    minHeight: 50,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  notice: {
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.panel,
    borderRadius: radii.control,
  },
  loading: {
    padding: spacing.xxl,
    gap: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    minHeight: 56,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { ...typography.header, color: colors.bright, textAlign: "center" },
  webOverlay: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  webSheet: {
    backgroundColor: colors.background,
    width: "100%",
    maxWidth: 600,
    maxHeight: "90%",
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    overflow: "hidden",
  },
  pickerOverlay: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  pickerSheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    maxWidth: 520,
  },
  grabber: {
    width: 32,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.dim,
    alignSelf: "center",
    marginTop: spacing.sm,
  },
  pickerHeader: {
    minHeight: 72,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  pickerClose: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  pickerTitle: { ...typography.header, color: colors.bright, flex: 1, textAlign: "center" },
  pickerContent: {
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  sheetContent: { flexGrow: 1, flexShrink: 1 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    padding: spacing.xl,
    gap: spacing.md,
  },
});
