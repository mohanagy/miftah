const workOwners = new Set(["acme"]);

/** @type {import("@lubab/miftah/plugin-api").RoutingMatcherPlugin} */
const plugin = {
  apiVersion: "1",
  id: "github-owner",
  kind: "routing-matcher",
  async match({ signals }) {
    const matchesWorkOwner = signals.some(
      (signal) =>
        signal.provider === "github" &&
        ((signal.kind === "organization" && workOwners.has(signal.value)) ||
          (signal.kind === "repository" && workOwners.has(signal.value.split("/", 1)[0] ?? "")))
    );
    return { bindings: matchesWorkOwner ? ["acme-work"] : [] };
  }
};

export default plugin;
