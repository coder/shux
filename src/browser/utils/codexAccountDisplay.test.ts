import { expect, test } from "bun:test";
import { formatCodexAccountLabel } from "./codexAccountDisplay";

const accounts = [
  { id: "slot-one", label: "Personal" },
  { id: "slot-two", label: "Personal" },
  { id: "slot-three", label: "Work" },
];

test("duplicate account labels use stable IDs regardless of list order", () => {
  const labels = accounts.map((account) => formatCodexAccountLabel(account, accounts));
  expect(new Set(labels).size).toBe(accounts.length);
  for (const account of accounts.slice(0, 2)) {
    const label = formatCodexAccountLabel(account, accounts);
    expect(label).toContain(account.id);
    expect(label).toContain(account.label);
    expect(formatCodexAccountLabel(account, accounts.toReversed())).toBe(label);
  }
  expect(labels[2]).toBe(accounts[2].label);
});

test("renaming or removing a duplicate restores the unique label without changing identity", () => {
  const [first, second] = accounts;
  const renamed = { ...second, label: "Home" };
  expect(formatCodexAccountLabel(first, [first, renamed])).toBe(first.label);
  expect(formatCodexAccountLabel(renamed, [first, renamed])).toBe(renamed.label);
  expect(formatCodexAccountLabel(first, [first])).toBe(first.label);
  expect(first).toEqual({ id: "slot-one", label: "Personal" });
});
