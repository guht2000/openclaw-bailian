import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildBailianVoiceProvider } from "./bridge.js";

export default definePluginEntry({
  id: "bailian-voice",
  name: "Bailian Realtime Voice",
  description: "Alibaba Bailian Qwen-Audio-Realtime voice provider for Talk",
  register(api) {
    const pluginConfig = api.pluginConfig || {};
    api.registerRealtimeVoiceProvider((deps) => buildBailianVoiceProvider({ ...(deps || {}), pluginConfig }));
  },
});
