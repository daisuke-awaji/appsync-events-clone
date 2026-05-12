import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "fanout-worker",
    globals: false,
    setupFiles: ["./test/setup-env.ts"],
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
