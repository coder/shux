import tailwindcss from "eslint-plugin-tailwindcss";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { tailwindcss },
    settings: {
      tailwindcss: {
        // Don't try to load Tailwind config (v4 doesn't export resolveConfig)
        config: false,
        cssFiles: ["**/*.css", "!**/node_modules", "!**/.*", "!**/dist", "!**/build"],
        callees: [],
      },
    },
    rules: {
      "tailwindcss/classnames-order": "warn",
    },
  },
];
