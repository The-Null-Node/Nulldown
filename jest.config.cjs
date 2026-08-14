module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/shared"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "<rootDir>/tsconfig.test.json",
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@thenullnode/nulldown/client$": "<rootDir>/src/client/nulldownClient.ts",
    "^@thenullnode/nulldown/drop/diff$": "<rootDir>/shared/drop/diff.ts",
    "^@thenullnode/nulldown/nulledit/types$": "<rootDir>/shared/nulledit/types.ts",
  },
  clearMocks: true,
};
