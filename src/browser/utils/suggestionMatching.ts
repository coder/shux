/**
 * Match-quality tiers for suggestion name matching. Lower ranks first; ties
 * keep the caller's original order (discovery lists are alphabetical), so an
 * exact name beats a whole-name prefix beats a mid-name segment prefix —
 * typing "/lint" must rank a `lint` skill above `auto-lint`.
 */
export const NAME_MATCH_RANK = {
  exact: 0,
  namePrefix: 1,
  segmentPrefix: 2,
} as const;

/**
 * Case-insensitive match quality of `partial` against a hyphenated name, or
 * null when it doesn't match. Empty or whitespace-only partials match every
 * name at equal rank (a bare "/" lists everything in original order).
 */
export function rankNameMatch(name: string, partial: string): number | null {
  const normalizedPartial = partial.trim().toLowerCase();
  const normalizedName = name.toLowerCase();

  if (normalizedPartial.length === 0) {
    return NAME_MATCH_RANK.namePrefix;
  }
  if (normalizedName === normalizedPartial) {
    return NAME_MATCH_RANK.exact;
  }
  if (normalizedName.startsWith(normalizedPartial)) {
    return NAME_MATCH_RANK.namePrefix;
  }
  if (normalizedName.split("-").some((segment) => segment.startsWith(normalizedPartial))) {
    return NAME_MATCH_RANK.segmentPrefix;
  }
  return null;
}

/**
 * Case-insensitive prefix match against a hyphenated name.
 *
 * Returns true when `partial` is a prefix of the full name or any
 * hyphen-delimited segment. Empty or whitespace-only partials match everything.
 */
export function matchesNameBySegmentPrefix(name: string, partial: string): boolean {
  return rankNameMatch(name, partial) !== null;
}

/**
 * Filter `items` to those whose name matches `partial`, best match first.
 * The sort is stable, so items within a tier keep their original order.
 */
export function filterAndRankByNameMatch<T>(
  items: readonly T[],
  partial: string,
  getName: (item: T) => string
): T[] {
  return items
    .flatMap((item) => {
      const rank = rankNameMatch(getName(item), partial);
      return rank === null ? [] : [{ item, rank }];
    })
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.item);
}
