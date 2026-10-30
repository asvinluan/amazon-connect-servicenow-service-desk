import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Fake AWS settings so no test can reach real AWS, even by accident.
    // POWERTOOLS_DEV makes the logger and metrics write through console.log,
    // which lets the tests read exactly what would reach CloudWatch.
    env: {
      AWS_REGION: "ap-southeast-2",
      AWS_DEFAULT_REGION: "ap-southeast-2",
      AWS_ACCESS_KEY_ID: "testing",
      AWS_SECRET_ACCESS_KEY: "testing",
      POWERTOOLS_DEV: "true",
      // Metrics are switched off by POWERTOOLS_DEV unless told otherwise.
      POWERTOOLS_METRICS_DISABLED: "false",
      POWERTOOLS_SERVICE_NAME: "servicedesk",
      POWERTOOLS_METRICS_NAMESPACE: "AmazonConnectLab",
      POWERTOOLS_LOG_LEVEL: "DEBUG",
    },
  },
});
