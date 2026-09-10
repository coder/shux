import { Platform, StyleSheet } from "react-native";

import { mobileThemeColors as colors } from "../../../src/common/constants/mobileThemeColors.generated";

export { colors };

export const WIDE_LAYOUT_MIN_WIDTH = 900;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };
export const radii = { control: 12, card: 16, sheet: 24, pill: 999 };
// TextInput does not inherit Text typography on web; share the native system face explicitly.
export const fontFamily = Platform.OS === "android" ? "sans-serif" : "System";
export const typography = StyleSheet.create({
  title: { fontFamily, fontSize: 24, lineHeight: 30, fontWeight: "600", letterSpacing: -0.5 },
  header: { fontFamily, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontFamily, fontSize: 16, lineHeight: 25 },
  secondary: { fontFamily, fontSize: 15, lineHeight: 22 },
  footnote: { fontFamily, fontSize: 13, lineHeight: 18 },
});
export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
export const layout = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  text: { ...typography.body, color: colors.text },
  muted: { ...typography.secondary, color: colors.muted },
  title: { ...typography.title, color: colors.bright },
  label: { ...typography.footnote, color: colors.muted, fontWeight: "600" },
  content: {
    padding: spacing.xl,
    gap: spacing.xl,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  group: { backgroundColor: colors.panel, borderRadius: radii.card, overflow: "hidden" },
});
