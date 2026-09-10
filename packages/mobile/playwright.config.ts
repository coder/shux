import { defineConfig } from "@playwright/test";

// Tests create disposable scratch chats. Never silently point this at a user's server.
if (!process.env.XUM_MOBILE_TEST_ENDPOINT || !process.env.XUM_MOBILE_TEST_TOKEN) {
  throw new Error(
    "Set XUM_MOBILE_TEST_ENDPOINT and XUM_MOBILE_TEST_TOKEN for a disposable server."
  );
}
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  outputDir: process.env.XUM_MOBILE_TEST_ARTIFACTS ?? ".expo/test-results",
  use: {
    baseURL: process.env.XUM_MOBILE_TEST_WEB_URL ?? "http://127.0.0.1:8082",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "phone-375", use: { viewport: { width: 375, height: 812 } } },
    { name: "phone-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "wide", use: { viewport: { width: 1200, height: 900 } } },
  ],
});
