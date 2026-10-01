import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { buildBailianRealtimeProvider } from "./session.js";

const PLUGIN_ID = "bailian-realtime";
const CREDENTIAL_PATH = "plugins.entries." + PLUGIN_ID + ".config.apiKey";

/**
 * The host hands a plugin its config verbatim, so a SecretRef arrives here as
 * an object. Resolve it ourselves and keep the value in a closure; the
 * provider reads it synchronously once resolved.
 */
function createCredentialSource(rawValue, runtimeConfig) {
  if (typeof rawValue === "string" && rawValue.trim()) return () => rawValue.trim();
  if (!rawValue || typeof rawValue !== "object") return () => undefined;

  let cached;
  Promise.resolve()
    .then(() =>
      resolveConfiguredSecretInputString({
        config: runtimeConfig,
        env: process.env,
        value: rawValue,
        path: CREDENTIAL_PATH,
      }),
    )
    .then((result) => {
      if (result && typeof result.value === "string" && result.value) cached = result.value;
    })
    .catch(() => {});
  return () => cached;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Bailian Realtime Transcription",
  description: "Alibaba Bailian realtime speech-to-text for Talk",
  register(api) {
    const pluginConfig = api.pluginConfig || {};
    const getCredential = createCredentialSource(pluginConfig.apiKey, api.config || {});
    api.registerRealtimeTranscriptionProvider((deps) =>
      buildBailianRealtimeProvider({
        ...(deps || {}),
        pluginConfig,
        getResolvedCredential: getCredential,
      }),
    );
  },
});
