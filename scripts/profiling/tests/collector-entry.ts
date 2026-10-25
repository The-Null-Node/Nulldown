import collector from "../../../packages/nulldown-telemetry/src/worker";
/** Local-only external rate-limit fixture; production decoding/dispatch remains unchanged. */
export default {
  fetch(request: Request, env: Parameters<typeof collector.fetch>[1]) {
    return collector.fetch(
      request,
      Object.assign({}, env, {
        BROWSER_LIMIT: {
          async limit() {
            return { success: true };
          },
        },
      }),
    );
  },
};
