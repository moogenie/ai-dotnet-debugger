import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "node_modules/**", "eslint.config.mjs", "vitest.config.mts"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        { custom: { match: true, regex: "^I[A-Z]" }, format: ["PascalCase"], selector: "interface" },
      ],
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "no-magic-numbers": ["error", { ignore: [-1, 0, 1], ignoreArrayIndexes: true, ignoreDefaultValues: true }],
      "sort-keys": "error",
    },
  },
  {
    files: ["src/**/*.test.ts", "src/test/**/*.ts"],
    rules: { "no-magic-numbers": "off" },
  },
);
