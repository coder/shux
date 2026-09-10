import type { SetStateAction } from "react";
import { ScrollView, Text, View } from "react-native";
import { X } from "lucide-react-native";
import type { ChatDraft } from "../draft";
import { IconButton } from "./Controls";
import { layout, spacing } from "../theme";

export function DraftExtras(props: {
  draft: ChatDraft;
  onChange: (update: SetStateAction<ChatDraft>) => void;
}) {
  if (!props.draft.fileParts.length && !props.draft.reviews.length) return null;
  return (
    <ScrollView
      style={{ maxHeight: 132 }}
      contentContainerStyle={{ gap: spacing.xs }}
      keyboardShouldPersistTaps="handled"
    >
      {props.draft.fileParts.map((part, index) => {
        const name = part.filename ?? part.mediaType;
        return (
          <View key={index} style={layout.row}>
            <Text numberOfLines={1} style={[layout.muted, { flex: 1, minWidth: 0 }]}>
              {name}
            </Text>
            <IconButton
              label={`Remove attachment ${name}`}
              icon={X}
              onPress={() =>
                props.onChange((current) => ({
                  ...current,
                  fileParts: current.fileParts.filter((_, item) => item !== index),
                }))
              }
            />
          </View>
        );
      })}
      {props.draft.reviews.length > 0 && (
        <View style={layout.row}>
          <Text style={[layout.muted, { flex: 1 }]}>
            {props.draft.reviews.length} review{" "}
            {props.draft.reviews.length === 1 ? "note" : "notes"}
          </Text>
          <IconButton
            label="Remove review notes"
            icon={X}
            onPress={() => props.onChange((current) => ({ ...current, reviews: [] }))}
          />
        </View>
      )}
    </ScrollView>
  );
}
