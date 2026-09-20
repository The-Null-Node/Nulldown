declare module "bun:test" {
  export const describe: typeof import("@jest/globals").describe;
  export const expect: typeof import("@jest/globals").expect;
  export const test: typeof import("@jest/globals").test;
}
