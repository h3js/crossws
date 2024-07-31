import unjs from "eslint-config-unjs";

// https://github.com/unjs/eslint-config
export default unjs({
  ignores: [
  "types",
  "**/.docs/**",
],
  rules: {
  "@typescript-eslint/no-unused-vars": 0,
  "no-useless-constructor": 0,
  "unicorn/consistent-function-scoping": 0
},
});
