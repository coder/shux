import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Bot, Check, ChevronRight, ClipboardList, Code2 } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { FrontendWorkspaceMetadata } from "../../../../src/common/types/workspace";
import { Field, Sheet } from "../components/Controls";
import {
  modelChoices,
  modelName,
  modelMatchesSearch,
  resolveSettings,
  thinkingLevels,
} from "../settings";
import type { ChatSettings, SettingsData } from "../settings";
import type { ThinkingLevel } from "../../../../src/common/types/thinking";
import { colors, layout, radii, spacing, typography } from "../theme";

type Page = "model" | "effort" | "agent" | "custom";
const titles: Record<Page, string> = {
  model: "Select model",
  effort: "Effort",
  agent: "Select mode",
  custom: "Custom model",
};
const effortLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export function ModelSettings(props: {
  initialPage: "model" | "agent";
  value: ChatSettings;
  data: SettingsData;
  workspace: FrontendWorkspaceMetadata;
  onChange: (value: ChatSettings) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<Page>(props.initialPage);
  const [query, setQuery] = useState("");
  const [customModel, setCustomModel] = useState(props.value.model);
  const models = modelChoices(props.data, props.value.model);
  // Search the entire Settings-visible catalog in the main sheet, not a provider shortlist.
  const filtered = models.filter((model) =>
    modelMatchesSearch(model, query, providerName(model.split(":")[0]))
  );
  const groups = new Map<string, string[]>();
  for (const model of filtered) {
    const provider = model.split(":")[0];
    groups.set(provider, [...(groups.get(provider) ?? []), model]);
  }
  function providerName(provider: string) {
    return props.data.providers[provider]?.displayName ?? provider;
  }
  function selectModel(model: string) {
    props.onChange({ ...props.value, model });
    props.onClose();
  }
  function modelRow(model: string, index: number) {
    return (
      <PickerRow
        key={model}
        label={modelName(model)}
        subtitle={providerName(model.split(":")[0])}
        accessibilityLabel={model}
        selected={model === props.value.model}
        separator={index > 0}
        onPress={() => selectModel(model)}
      />
    );
  }
  const validCustom = /^\S+:\S+$/.test(customModel.trim());
  return (
    <Sheet
      variant="picker"
      title={titles[page]}
      onClose={props.onClose}
      onBack={page === "effort" || page === "custom" ? () => setPage("model") : undefined}
      action={
        page === "custom" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Use custom model"
            accessibilityState={{ disabled: !validCustom }}
            disabled={!validCustom}
            onPress={() => selectModel(customModel.trim())}
            style={styles.done}
          >
            <Text
              style={[typography.header, { color: validCustom ? colors.selection : colors.dim }]}
            >
              Done
            </Text>
          </Pressable>
        )
      }
    >
      {page === "model" && (
        <>
          <Field
            label="Search models"
            placeholder="Model or provider"
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          <View style={styles.group}>
            <PickerRow
              label="Effort"
              detail={
                props.value.thinkingLevel ? effortLabels[props.value.thinkingLevel] : "Default"
              }
              onPress={() => setPage("effort")}
              disclosure
            />
          </View>
          {[...groups].map(([provider, choices]) => (
            <View key={provider} style={styles.section}>
              <Text style={styles.sectionLabel}>{providerName(provider)}</Text>
              <View style={styles.group}>{choices.map(modelRow)}</View>
            </View>
          ))}
          {filtered.length === 0 && <Text style={layout.muted}>No matching models.</Text>}
          <View style={styles.group}>
            <PickerRow label="Custom model" onPress={() => setPage("custom")} disclosure />
          </View>
        </>
      )}
      {page === "effort" && (
        <>
          <View style={styles.group}>
            <PickerRow
              label="Default"
              selected={props.value.thinkingLevel == null}
              onPress={() => {
                props.onChange({ ...props.value, thinkingLevel: undefined });
                setPage("model");
              }}
            />
            {thinkingLevels.map((level) => (
              <PickerRow
                key={level}
                label={effortLabels[level]}
                separator
                selected={props.value.thinkingLevel === level}
                onPress={() => {
                  props.onChange({ ...props.value, thinkingLevel: level });
                  setPage("model");
                }}
              />
            ))}
          </View>
          <Text style={styles.note}>
            Available effort levels depend on the model. Your server applies its capabilities.
          </Text>
        </>
      )}
      {page === "agent" && (
        <View style={styles.group}>
          {props.data.agents
            .filter((agent) => agent.uiSelectable)
            .map((agent, index) => (
              <PickerRow
                key={agent.id}
                label={agent.name}
                subtitle={agent.description}
                separator={index > 0}
                icon={agent.id === "exec" ? Code2 : agent.id === "plan" ? ClipboardList : Bot}
                selected={agent.id === props.value.agentId}
                onPress={() => {
                  // Mode and model are separate controls: choosing a mode must not replace an explicit model/effort.
                  if (agent.id !== props.value.agentId) {
                    // Reasoning belongs to the target agent; legacy buckets resolve to Standard.
                    const target = resolveSettings(props.workspace, props.data, agent.id);
                    props.onChange(
                      props.value.model
                        ? {
                            ...props.value,
                            agentId: agent.id,
                            reasoningMode: target.reasoningMode ?? props.value.reasoningMode,
                          }
                        : target
                    );
                  }
                  props.onClose();
                }}
              />
            ))}
        </View>
      )}
      {page === "custom" && (
        <>
          <Field
            label="Model ID"
            placeholder="provider:model"
            value={customModel}
            onChangeText={setCustomModel}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (validCustom) selectModel(customModel.trim());
            }}
          />
          <Text style={styles.note}>
            Enter a model supported by a configured server provider, in provider:model format.
          </Text>
        </>
      )}
    </Sheet>
  );
}

function PickerRow(props: {
  label: string;
  subtitle?: string;
  detail?: string;
  accessibilityLabel?: string;
  selected?: boolean;
  separator?: boolean;
  disclosure?: boolean;
  icon?: LucideIcon;
  onPress: () => void;
}) {
  const Icon = props.icon;
  return (
    <Pressable
      accessibilityRole={props.selected == null ? "button" : "radio"}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={props.selected == null ? undefined : { checked: props.selected }}
      aria-checked={props.selected}
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.elevated }]}
    >
      <View style={[styles.rowContent, props.separator && styles.separator]}>
        {Icon && <Icon size={22} color={colors.muted} />}
        <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}>
          <Text style={styles.rowTitle}>{props.label}</Text>
          {props.subtitle && <Text style={styles.note}>{props.subtitle}</Text>}
        </View>
        {props.detail && <Text style={layout.muted}>{props.detail}</Text>}
        {props.selected && <Check size={23} color={colors.selection} />}
        {props.disclosure && <ChevronRight size={20} color={colors.dim} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: radii.sheet, backgroundColor: colors.panel, overflow: "hidden" },
  section: { gap: spacing.sm },
  sectionLabel: { ...typography.footnote, color: colors.muted, paddingHorizontal: spacing.lg },
  row: { paddingHorizontal: spacing.lg },
  rowContent: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowTitle: { ...typography.body, fontSize: 17, color: colors.bright },
  note: { ...typography.footnote, color: colors.muted },
  done: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
});
