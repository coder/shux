import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, layout, mono, radii, spacing, typography } from "../theme";

type Block =
  | { type: "paragraph" | "heading"; text: string }
  | { type: "code"; language: string; text: string }
  | { type: "list"; items: Array<{ marker: string; text: string; indent: number }> };

const listItem = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/;
const heading = /^ {0,3}#{1,6}\s+(.+)$/;
const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/;

function blocks(text: string): Block[] {
  const lines = text.split("\n");
  const result: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const opening = fence.exec(line);
    if (opening) {
      const start = ++index;
      const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`);
      while (index < lines.length && !closing.test(lines[index])) index++;
      // Preserve code whitespace and unfinished streaming fences instead of reinterpreting
      // their content as Markdown (or hiding it until the closing fence arrives).
      const code =
        lines.slice(start, index).join("\n") + (index < lines.length && index > start ? "\n" : "");
      result.push({ type: "code", language: opening[2].trim(), text: code });
      if (index < lines.length) index++;
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      result.push({ type: "heading", text: title[1] });
      index++;
      continue;
    }
    if (listItem.test(line)) {
      const items: Extract<Block, { type: "list" }>["items"] = [];
      while (index < lines.length) {
        const item = listItem.exec(lines[index]);
        if (!item) break;
        index++;
        let content = item[3];
        while (
          index < lines.length &&
          /^\s+\S/.test(lines[index]) &&
          !listItem.test(lines[index]) &&
          !fence.test(lines[index]) &&
          !heading.test(lines[index])
        ) {
          content += `\n${lines[index].trimStart()}`;
          index++;
        }
        items.push({
          marker: /^\d/.test(item[2]) ? item[2] : "•",
          text: content,
          indent: item[1].length,
        });
      }
      result.push({ type: "list", items });
      continue;
    }
    const start = index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !heading.test(lines[index]) &&
      !fence.test(lines[index]) &&
      !listItem.test(lines[index])
    )
      index++;
    result.push({ type: "paragraph", text: lines.slice(start, index).join("\n") });
  }
  return result;
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    if (/^`[^`\n]+`$/.test(part))
      return (
        <Text key={index} style={styles.inlineCode}>
          {part.slice(1, -1)}
        </Text>
      );
    if (/^\*\*[^*\n]+\*\*$/.test(part))
      return (
        <Text key={index} style={{ fontWeight: "600" }}>
          {part.slice(2, -2)}
        </Text>
      );
    return part;
  });
}

// Repo/model text is untrusted: all content remains escaped native Text, never HTML.
export function Markdown(props: { text: string }) {
  return (
    <View style={styles.content}>
      {blocks(props.text).map((block, index) => {
        if (block.type === "code")
          return (
            <View key={index} style={styles.code}>
              {block.language !== "" && <Text style={styles.codeLanguage}>{block.language}</Text>}
              <ScrollView horizontal contentContainerStyle={styles.codeBody}>
                <Text selectable style={styles.codeText}>
                  {block.text}
                </Text>
              </ScrollView>
            </View>
          );
        if (block.type === "list")
          return (
            <View key={index} role="list" style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View
                  key={itemIndex}
                  role="listitem"
                  style={[styles.listItem, { marginLeft: Math.min(item.indent, 6) * spacing.sm }]}
                >
                  <Text style={[layout.text, styles.marker]}>{item.marker}</Text>
                  <Text selectable style={[layout.text, styles.itemText]}>
                    {inline(item.text)}
                  </Text>
                </View>
              ))}
            </View>
          );
        return (
          <Text
            key={index}
            selectable
            accessibilityRole={block.type === "heading" ? "header" : undefined}
            style={[layout.text, block.type === "heading" && styles.heading]}
          >
            {inline(block.text)}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg, minWidth: 0 },
  inlineCode: { fontFamily: mono, backgroundColor: colors.user, color: colors.bright },
  heading: { ...typography.header, color: colors.bright, marginTop: spacing.sm },
  list: { gap: spacing.md },
  listItem: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  marker: { minWidth: 20, textAlign: "right", color: colors.muted },
  itemText: { flex: 1, minWidth: 0 },
  code: { backgroundColor: colors.panel, borderRadius: radii.control, overflow: "hidden" },
  codeLanguage: {
    ...typography.footnote,
    color: colors.muted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  codeBody: { padding: spacing.lg },
  codeText: { ...typography.footnote, fontFamily: mono, lineHeight: 21, color: colors.text },
});
