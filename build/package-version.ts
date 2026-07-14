import packageManifest from "../package.json" with { type: "json" };

export const packageVersion = packageManifest.version;
