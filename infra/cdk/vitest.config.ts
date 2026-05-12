import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cdk",
    globals: false,
    include: ["test/**/*.test.ts"],
  },
});
