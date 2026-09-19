/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  helpUrl:
    "https://www.conventionalcommits.org/en/v1.0.0/#summary — releasable: feat (minor), fix (patch), BREAKING CHANGE / type! (major). See README.md → Releasing",
  rules: {
    "body-max-line-length": [1, "always", 200],
    "header-max-length": [2, "always", 120],
  },
};
