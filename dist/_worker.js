
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // For all requests, serve static assets
    return env.ASSETS.fetch(request);
  },
};
