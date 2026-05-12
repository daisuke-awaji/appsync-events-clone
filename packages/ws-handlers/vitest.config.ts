import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "ws-handlers",
    globals: false,
    setupFiles: ["./test/setup-env.ts"],
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
