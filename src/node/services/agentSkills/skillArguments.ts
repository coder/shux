import assert from "@/common/utils/assert";

/**
 * Placeholder syntax for slash-command skill arguments (Claude Code-compatible):
 * - `$ARGUMENTS` — the full trimmed argument text.
 * - `$1`..`$9` — whitespace-tokenized positional arguments.
 *
 * Word-boundary rules:
 * - `$ARGUMENTS` must not match longer identifiers like `$ARGUMENTSFOO` (the `\b`).
 * - A positional placeholder consumes exactly one digit (bash-style), so `$10` is
 *   interpreted as `$1` followed by a literal `0`.
 */
const SKILL_ARGUMENT_PLACEHOLDER_SOURCE = String.raw`\$(ARGUMENTS\b|[1-9])`;
const SKILL_ARGUMENT_PLACEHOLDER_RE = new RegExp(SKILL_ARGUMENT_PLACEHOLDER_SOURCE, "g");

/**
 * Whether substitution can change the body's size: a body that repeats
 * `$ARGUMENTS` (or a positional) expands with the argument text, up to the
 * snapshot cap, so size estimates made from the raw body must price the cap.
 */
export function skillBodyHasArgumentPlaceholders(body: string): boolean {
  return new RegExp(SKILL_ARGUMENT_PLACEHOLDER_SOURCE).test(body);
}

/**
 * Substitute slash-command argument placeholders in an agent skill body.
 *
 * Semantics (kept intentionally Claude Code-compatible):
 * - Tokenization is a simple whitespace split — no shell quoting rules, so `"a b"` is
 *   two tokens (`"a` and `b"`).
 * - Positions without a corresponding token become empty strings, as does `$ARGUMENTS`
 *   when the argument text is empty.
 * - Placeholders match everywhere in the body, including inside code blocks. This is
 *   intentional (matches Claude Code) and keeps the implementation predictable.
 * - Substitution is a single pass over the original body, so placeholder-like text
 *   inside argument values is never re-substituted.
 *
 * `substituted` is true iff at least one placeholder was found — even when the argument
 * text is empty (placeholders are then replaced with empty strings).
 */
export function substituteSkillArguments(
  body: string,
  argumentText: string
): { body: string; substituted: boolean } {
  assert(typeof body === "string", "substituteSkillArguments requires a string body");
  assert(
    typeof argumentText === "string",
    "substituteSkillArguments requires string argument text"
  );

  const trimmedArguments = argumentText.trim();
  // Guard the empty case: "".split(/\s+/) yields [""], not [].
  const positionalArguments = trimmedArguments.length > 0 ? trimmedArguments.split(/\s+/) : [];

  let substituted = false;
  const substitutedBody = body.replace(
    SKILL_ARGUMENT_PLACEHOLDER_RE,
    (match, placeholder: string) => {
      substituted = true;
      if (placeholder === "ARGUMENTS") {
        return trimmedArguments;
      }

      const position = Number(placeholder);
      assert(
        Number.isInteger(position) && position >= 1 && position <= 9,
        `unexpected positional placeholder: ${match}`
      );
      return positionalArguments[position - 1] ?? "";
    }
  );

  return { body: substitutedBody, substituted };
}
