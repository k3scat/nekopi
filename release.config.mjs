export default {
  branches: ["main"],
  repositoryUrl: "https://github.com/k3scat/nekopi.git",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { tarballDir: "." }],
    ["@semantic-release/github", {
      assets: "*.tgz",
      successComment: false,
      failComment: false,
      releasedLabels: false,
    }],
  ],
};
