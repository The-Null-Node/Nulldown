// Local compiler guard: deny networking and incidental production config loads.
// Current source config is read-only compiler input; networking is forbidden.
require("node:net").Socket.prototype.connect = function () {
  throw new Error("Network blocked in local build");
};
global.fetch = async () => {
  throw new Error("Network blocked in local build");
};
