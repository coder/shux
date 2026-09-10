import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", ".expo/**", "ios/**", "android/**", "metro.config.cjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Metro loads this build-time generator synchronously from its CommonJS config.
    files: ["scripts/generateTheme.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { __dirname: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  }
);
