function transformImportMetaForJest({ types: t }) {
  // Shared by MemberExpression and OptionalMemberExpression (`import.meta?.env`,
  // used by the ESM-only `effect` package) so both spellings rewrite identically.
  function rewriteImportMetaMember(path) {
    if (!t.isMetaProperty(path.node.object)) return;

    const meta = path.node.object;
    if (meta.meta.name !== "import" || meta.property.name !== "meta") return;
    if (!t.isIdentifier(path.node.property)) return;

    if (path.node.property.name === "env") {
      path.replaceWith(t.memberExpression(t.identifier("process"), t.identifier("env")));
      return;
    }

    if (path.node.property.name === "url") {
      // `import.meta.url` -> `require("url").pathToFileURL(__filename).toString()`
      const requireUrl = t.callExpression(t.identifier("require"), [t.stringLiteral("url")]);
      const pathToFileURL = t.memberExpression(requireUrl, t.identifier("pathToFileURL"));
      const fileUrl = t.callExpression(pathToFileURL, [t.identifier("__filename")]);
      const toString = t.memberExpression(fileUrl, t.identifier("toString"));
      path.replaceWith(t.callExpression(toString, []));
    }
  }

  return {
    name: "transform-import-meta-for-jest",
    visitor: {
      MemberExpression: rewriteImportMetaMember,
      OptionalMemberExpression: rewriteImportMetaMember,
    },
  };
}

module.exports = {
  presets: [
    [
      "@babel/preset-env",
      {
        targets: {
          node: "current",
        },
        modules: "commonjs",
      },
    ],
    [
      "@babel/preset-typescript",
      {
        allowDeclareFields: true,
      },
    ],
    [
      "@babel/preset-react",
      {
        runtime: "automatic",
      },
    ],
  ],

  env: {
    test: {
      // Jest runs with CommonJS output (`modules: "commonjs"` above) which cannot
      // evaluate `import.meta.*` references. Vite-only code paths use:
      // - `import.meta.env.*`
      // - `import.meta.url`
      // This plugin rewrites those to safe Node equivalents for Jest.
      plugins: [transformImportMetaForJest],
    },
  },
};
