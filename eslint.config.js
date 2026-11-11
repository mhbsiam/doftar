import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/** Type-aware rules stay off: `tsc --noEmit` in `npm run build` already checks types. */
export default tseslint.config(...tseslint.configs.recommended, {
  plugins: { "react-hooks": reactHooks },
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "error",
    // `_name` marks a value taken only to leave it out, as in `const { [key]: _, ...rest } = map`.
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
    ],
  },
});
