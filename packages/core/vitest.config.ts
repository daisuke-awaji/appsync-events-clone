import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "core",
    globals: false,
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
