import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { TokenMeterData } from "../../../../src/common/utils/tokens/tokenMeterUtils";
import { formatTokens } from "../../../../src/common/utils/tokens/tokenMeterUtils";
import { colors, fontFamily } from "../theme";

const circumference = 2 * Math.PI * 14;

export function ContextUsage(props: { data: TokenMeterData }) {
  const known = props.data.maxTokens != null;
  const percentage = Math.max(0, Math.min(100, props.data.totalPercentage));
  const value = known ? `${Math.round(props.data.totalPercentage)}%` : "—";
  const detail = known
    ? `${value}, ${formatTokens(props.data.totalTokens)} of ${formatTokens(props.data.maxTokens!)} tokens`
    : props.data.totalTokens > 0
      ? `${formatTokens(props.data.totalTokens)} tokens; context limit unknown`
      : "No context usage reported yet";
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Context usage"
      accessibilityValue={
        known ? { min: 0, max: 100, now: percentage, text: detail } : { text: detail }
      }
      style={styles.meter}
    >
      <Svg width={34} height={34} viewBox="0 0 34 34" accessible={false}>
        <Circle cx={17} cy={17} r={14} fill="none" stroke={colors.border} strokeWidth={2} />
        {known && (
          <Circle
            cx={17}
            cy={17}
            r={14}
            fill="none"
            stroke={colors.accent}
            strokeWidth={2}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - percentage / 100)}
            rotation={-90}
            origin="17, 17"
          />
        )}
      </Svg>
      <Text accessible={false} style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { width: 34, height: 34, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  value: {
    position: "absolute",
    fontFamily,
    fontSize: 9,
    fontVariant: ["tabular-nums"],
    color: colors.muted,
  },
});
