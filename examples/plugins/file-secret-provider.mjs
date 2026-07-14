import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = "secretref:file-local://";
const pluginDirectory = await realpath(dirname(fileURLToPath(import.meta.url)));

/** @type {import("@lubab/miftah/plugin-api").SecretProviderPlugin} */
const plugin = {
  apiVersion: "1",
  id: "file-local",
  kind: "secret-provider",
  async resolve({ reference }) {
    const name = fileName(reference);
    const target = await realpath(resolve(pluginDirectory, name));
    const pathFromPlugin = relative(pluginDirectory, target);
    if (pathFromPlugin.length === 0 || pathFromPlugin.startsWith("..") || isAbsolute(pathFromPlugin)) {
      throw new Error("The requested secret file is outside the plugin directory.");
    }
    const value = removeOneTerminalLineEnding(await readFile(target, "utf8"));
    if (value.length === 0 || value.includes("\u0000")) throw new Error("The requested secret file is empty or invalid.");
    return { value };
  }
};

export default plugin;

function fileName(reference) {
  if (!reference.startsWith(prefix)) throw new Error("Unsupported secret reference.");
  let name;
  try {
    name = decodeURIComponent(reference.slice(prefix.length));
  } catch {
    throw new Error("Malformed secret reference.");
  }
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\u0000")
  ) {
    throw new Error("Secret references must name one file beside this plugin.");
  }
  return name;
}

function removeOneTerminalLineEnding(value) {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}
