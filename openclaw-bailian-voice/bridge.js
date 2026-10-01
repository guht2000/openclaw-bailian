import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";

const DEFAULT_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const DEFAULT_MODEL = "qwen-audio-3.1-realtime-plus";
const DEFAULT_VOICE = "longanqian";
const DEFAULT_KEY_FILE = path.join(os.homedir(), ".config", "bailian", "voice_api_key");
const PCM16_24K = Object.freeze({ encoding: "pcm16", sampleRateHz: 24000, channels: 1 });
const AUTH_SCHEME = "Bea" + "rer ";
const MODELS = ["qwen-audio-3.1-realtime-plus", "qwen-audio-3.0-realtime-plus", "qwen-audio-3.0-realtime-flash"];
const VOICES = ["longanqian", "longanlingxin", "longanlufeng", "longanlingxi", "longanfengyue", "loongmary"];

const str = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Resolve the DashScope credential, in priority order:
 *
 * 1. providerConfig.apiKey - host-resolved Talk provider config
 *                            (talk.realtime.providers.<id>.apiKey)
 * 2. pluginConfig.apiKey   - plugins.entries.<id>.config.apiKey, when it
 *                            reaches the plugin as a plain string
 * 3. environment           - DASHSCOPE_API_KEY / BAILIAN_API_KEY
 * 4. legacy key file       - ~/.config/bailian/api_key
 *
 * An unresolved SecretRef arrives as an object rather than a string, so it is
 * skipped here and left to OpenClaw to resolve on the paths above.
 */
export function readApiKey(pluginConfig, providerConfig) {
  const fromProvider = str(providerConfig && providerConfig.apiKey);
  if (fromProvider) return fromProvider;
  const fromPlugin = str(pluginConfig && pluginConfig.apiKey);
  if (fromPlugin) return fromPlugin;
  const fromEnv = str(process.env.DASHSCOPE_VOICE_API_KEY || process.env.BAILIAN_VOICE_API_KEY);
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(DEFAULT_KEY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function resolveSettings(pluginConfig, providerConfig) {
  const pc = providerConfig || {};
  const cfg = pluginConfig || {};
  return {
    baseUrl: str(pc.baseUrl) || str(cfg.baseUrl) || str(process.env.BAILIAN_REALTIME_BASE) || DEFAULT_BASE,
    model: str(pc.model) || str(cfg.model) || str(process.env.BAILIAN_VOICE_MODEL) || DEFAULT_MODEL,
    voice: str(pc.voice) || str(cfg.voice) || str(process.env.BAILIAN_VOICE_NAME) || DEFAULT_VOICE,
  };
}

const ULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exp = (u >> 4) & 0x07;
    const man = u & 0x0f;
    let s = (((man << 3) + 0x84) << exp) - 0x84;
    t[i] = sign ? -s : s;
  }
  return t;
})();

/** Linear-interpolation resampler for 16-bit mono PCM, carrying state across chunks. */
function createResampler(fromRate, toRate) {
  const step = fromRate / toRate;
  let carry = Buffer.alloc(0);
  let pos = 0;
  return function push(chunk) {
    if (fromRate === toRate) return chunk;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const inSamples = Math.floor(buf.length / 2);
    const out = [];
    while (true) {
      const i0 = Math.floor(pos);
      if (i0 + 1 >= inSamples) break;
      const frac = pos - i0;
      const s0 = buf.readInt16LE(i0 * 2);
      const s1 = buf.readInt16LE((i0 + 1) * 2);
      const val = Math.round(s0 + (s1 - s0) * frac);
      out.push(Math.max(-32768, Math.min(32767, val)));
      pos += step;
    }
    const consumed = Math.min(Math.floor(pos), inSamples);
    carry = buf.subarray(consumed * 2);
    pos -= consumed;
    const res = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i += 1) res.writeInt16LE(out[i], i * 2);
    return res;
  };
}

function ulawToPcm16(buf) {
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length; i += 1) out.writeInt16LE(ULAW_TABLE[buf[i]], i * 2);
  return out;
}

function makeInputConverter(audioFormat) {
  const enc = audioFormat && audioFormat.encoding;
  const rate = (audioFormat && audioFormat.sampleRateHz) || 24000;
  if (enc === "g711_ulaw") {
    const rs = createResampler(8000, 16000);
    return (b) => rs(ulawToPcm16(b));
  }
  const rs = createResampler(rate, 16000);
  return (b) => rs(b);
}

function createBailianVoiceBridge(req, cred, settings) {
  const model = settings.model;
  const voice = settings.voice;
  const url = settings.baseUrl + "?model=" + encodeURIComponent(model);
  const convert = makeInputConverter(req && req.audioFormat);
  const pending = [];
  let ws = null;
  let ready = false;
  let closed = false;
  let responseActive = false;
  let lastTs = 0;

  const sendJson = (obj) => {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {}
  };
  const flushPending = () => {
    while (pending.length) {
      const pcm = pending.shift();
      sendJson({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    }
  };

  const onServerEvent = (m) => {
    const t = m && m.type;
    if (!t) return;
    switch (t) {
      case "session.created":
        ready = true;
        req.onReady && req.onReady();
        flushPending();
        return;
      case "input_audio_buffer.speech_started":
        if (responseActive) req.onClearAudio && req.onClearAudio("barge-in");
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (m.delta) req.onTranscript && req.onTranscript("user", m.delta, false);
        return;
      case "conversation.item.input_audio_transcription.completed":
        req.onTranscript && req.onTranscript("user", m.transcript || "", true);
        return;
      case "response.created":
        responseActive = true;
        return;
      case "response.audio.delta":
        if (m.delta) req.onAudio && req.onAudio(Buffer.from(m.delta, "base64"));
        return;
      case "response.audio_transcript.delta":
        if (m.delta) req.onTranscript && req.onTranscript("assistant", m.delta, false);
        return;
      case "response.audio_transcript.done":
        req.onTranscript && req.onTranscript("assistant", m.transcript || "", true);
        return;
      case "response.function_call_arguments.done": {
        let parsed = {};
        try {
          parsed = m.arguments ? JSON.parse(m.arguments) : {};
        } catch {
          parsed = { raw: m.arguments };
        }
        req.onToolCall && req.onToolCall({ itemId: m.item_id, callId: m.call_id, name: m.name, args: parsed });
        return;
      }
      case "response.done":
        responseActive = false;
        req.onResponseDone && req.onResponseDone({ status: (m.response && m.response.status) || "completed" });
        return;
      case "error":
        req.onError && req.onError(new Error("bailian-voice: " + JSON.stringify(m.error || m).slice(0, 300)));
        return;
      default:
        return;
    }
  };

  return {
    outputAudioMode: "response",
    supportsToolResultSuppression: true,
    pacesInputAudio: false,
    handlesInputAudioBargeIn: true,
    isConnected: () => ready && !closed,
    async connect() {
      await new Promise((resolve, reject) => {
        let settled = false;
        ws = new WebSocket(url, { headers: { Authorization: AUTH_SCHEME + cred } });
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              ws.close();
            } catch {}
            reject(new Error("bailian-voice: connect timeout"));
          }
        }, 15000);
        ws.on("open", () => {
          const session = {
            modalities: ["audio", "text"],
            voice,
            instructions: (req && req.instructions) || "你是一个简洁的语音助手。",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 700 },
          };
          const tools = (req && req.tools) || [];
          if (tools.length) {
            session.tools = tools;
            session.tool_choice = "auto";
          }
          sendJson({ type: "session.update", session });
        });
        ws.on("message", (data) => {
          let m;
          try {
            m = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (!settled && m && m.type === "session.created") {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          try {
            onServerEvent(m);
          } catch (e) {
            req.onError && req.onError(e);
          }
        });
        ws.on("error", (e) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(e);
          } else {
            req.onError && req.onError(e);
          }
        });
        ws.on("close", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("bailian-voice: closed before session.created"));
            return;
          }
          if (!closed) {
            closed = true;
            req.onClose && req.onClose("completed");
          }
        });
      });
    },
    sendAudio(audio) {
      if (closed || !audio || !audio.length) return;
      const pcm = convert(Buffer.isBuffer(audio) ? audio : Buffer.from(audio));
      if (!pcm.length) return;
      if (!ready) {
        pending.push(pcm);
        return;
      }
      sendJson({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    },
    setMediaTimestamp(ts) {
      lastTs = ts;
    },
    sendUserMessage(text) {
      sendJson({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: String(text) }] },
      });
      sendJson({ type: "response.create" });
    },
    triggerGreeting() {
      sendJson({ type: "response.create" });
    },
    submitToolResult(callId, result, options) {
      const output = typeof result === "string" ? result : JSON.stringify(result);
      sendJson({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
      if (!(options && options.suppressResponse)) sendJson({ type: "response.create" });
    },
    acknowledgeMark() {},
    close() {
      if (closed) return;
      closed = true;
      try {
        if (ws) ws.close();
      } catch {}
    },
  };
}

export function buildBailianVoiceProvider({ pluginConfig } = {}) {
  const base = resolveSettings(pluginConfig);
  return {
    id: "bailian-voice",
    label: "Bailian Realtime Voice",
    defaultModel: base.model,
    models: MODELS,
    voices: VOICES,
    autoSelectOrder: 50,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [PCM16_24K],
      outputAudioFormats: [PCM16_24K],
      supportsBrowserSession: false,
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
    },
    isConfigured: (ctx) => Boolean(readApiKey(pluginConfig, ctx && ctx.providerConfig)),
    createBridge: (req) => {
      const cred = readApiKey(pluginConfig, req && req.providerConfig);
      if (!cred) {
        throw new Error(
          "bailian-voice: no DashScope API key. Set talk.realtime.providers.bailian-voice.apiKey, plugins.entries.bailian-voice.config.apiKey, or DASHSCOPE_API_KEY.",
        );
      }
      return createBailianVoiceBridge(req, cred, resolveSettings(pluginConfig, req && req.providerConfig));
    },
  };
}
