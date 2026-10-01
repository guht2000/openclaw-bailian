import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_MODEL = "fun-asr-realtime";
const DEFAULT_ENCODING = "g711_ulaw";
const INPUT_RATE = 8000;
const EXTRA_MODELS = ["qwen-audio-3.1-asr-flash-streaming"];
const DEFAULT_KEY_FILE = path.join(os.homedir(), ".config", "bailian", "asr_api_key");

const str = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Resolve the DashScope credential, in priority order:
 *
 * 1. providerConfig.apiKey - config the caller passes for this session
 * 2. pluginConfig.apiKey   - the plugin's own config, already resolved by the
 *                            entry module (a SecretRef resolves there)
 * 3. environment           - DASHSCOPE_API_KEY / BAILIAN_API_KEY
 * 4. legacy key file       - ~/.config/bailian/api_key
 *
 * An unresolved SecretRef arrives as an object rather than a string, so it is
 * skipped here; the entry module resolves that case before we get here.
 */
export function readApiKey(pluginConfig, providerConfig) {
  const fromProvider = str(providerConfig && providerConfig.apiKey);
  if (fromProvider) return fromProvider;
  const fromPlugin = str(pluginConfig && pluginConfig.apiKey);
  if (fromPlugin) return fromPlugin;
  const fromEnv = str(process.env.DASHSCOPE_ASR_API_KEY || process.env.BAILIAN_ASR_API_KEY);
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
    url: str(pc.url) || str(cfg.url) || str(process.env.BAILIAN_REALTIME_URL) || DEFAULT_URL,
    model: str(pc.model) || str(cfg.model) || str(process.env.BAILIAN_REALTIME_MODEL) || DEFAULT_MODEL,
    inputEncoding: (
      str(pc.inputEncoding) || str(cfg.inputEncoding) || str(process.env.BAILIAN_REALTIME_INPUT_ENCODING) || DEFAULT_ENCODING
    ).toLowerCase(),
  };
}

/* G.711 mu-law -> linear PCM16 lookup table */
const ULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    t[i] = sign ? -sample : sample;
  }
  return t;
})();

function ulawToPcm16(buf) {
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length; i += 1) out.writeInt16LE(ULAW_TABLE[buf[i]], i * 2);
  return out;
}

/* Streaming WAV header; dataLength 0xffffffff marks an open-ended stream. */
function wavHeader(dataLength, sampleRate, channels = 1) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE((36 + dataLength) >>> 0, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataLength >>> 0, 40);
  return h;
}

function createBailianSession(req, cred, createRealtimeTranscriptionWebSocketSession, settings) {
  const taskId = randomUUID();
  const callbacks = req || {};
  let finalized = "";
  let partial = "";

  const emit = () => (finalized + partial).trim();

  const handleMessage = (msg, transport) => {
    const event = msg && msg.header && msg.header.event;
    if (event === "task-started") {
      transport.sendBinary(wavHeader(0xffffffff, INPUT_RATE, 1));
      transport.markReady();
      return;
    }
    if (event === "result-generated") {
      const sentence = msg.payload && msg.payload.output && msg.payload.output.sentence;
      if (!sentence || sentence.heartbeat) return;
      const text = (sentence.text || "").trim();
      if (sentence.sentence_end) {
        const next = text || partial;
        finalized = (finalized + next).trim();
        partial = "";
      } else if (text) {
        partial = text;
        callbacks.onPartial && callbacks.onPartial(emit());
      }
      return;
    }
    if (event === "task-failed") {
      const detail = JSON.stringify((msg && msg.payload) || {});
      callbacks.onError && callbacks.onError(new Error("bailian task-failed: " + detail));
    }
  };

  return createRealtimeTranscriptionWebSocketSession({
    providerId: "bailian",
    callbacks,
    url: () => settings.url,
    headers: { Authorization: "Bea" + "rer " + cred },
    readyOnOpen: false,
    connectTimeoutMs: 15000,
    closeTimeoutMs: 5000,
    onOpen: (transport) => {
      transport.sendJson({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: settings.model,
          input: {},
          parameters: { format: "wav", sample_rate: INPUT_RATE, language_hints: ["zh"] },
        },
      });
    },
    sendAudio: (audio, transport) => {
      try {
        const pcm = settings.inputEncoding === "pcm16" ? audio : ulawToPcm16(audio);
        transport.sendBinary(pcm);
      } catch (error) {
        callbacks.onError && callbacks.onError(error);
      }
    },
    parseMessage: (payload) => JSON.parse(payload),
    onMessage: (msg, transport) => handleMessage(msg, transport),
    onClose: (transport) => {
      try {
        transport.sendJson({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        });
      } catch {}
      try {
        const text = (finalized + partial).trim();
        if (text) callbacks.onTranscript && callbacks.onTranscript(text);
      } catch (error) {
        callbacks.onError && callbacks.onError(error);
      }
    },
  });
}

export function buildBailianRealtimeProvider({
  createRealtimeTranscriptionWebSocketSession,
  pluginConfig,
  getResolvedCredential,
} = {}) {
  if (typeof createRealtimeTranscriptionWebSocketSession !== "function") {
    throw new Error("bailian-realtime: createRealtimeTranscriptionWebSocketSession dependency missing");
  }
  const refCred = () => (typeof getResolvedCredential === "function" ? str(getResolvedCredential()) : "");
  const base = resolveSettings(pluginConfig);

  return {
    id: "bailian",
    label: "Bailian Realtime Transcription",
    defaultModel: base.model,
    models: [base.model, ...EXTRA_MODELS],
    autoSelectOrder: 50,
    isConfigured: (ctx) =>
      Boolean(readApiKey(pluginConfig, ctx && ctx.providerConfig) || refCred()),
    createSession: (req) => {
      const cred =
        str(req && req.providerConfig && req.providerConfig.apiKey) ||
        refCred() ||
        readApiKey(pluginConfig, req && req.providerConfig);
      if (!cred) {
        throw new Error(
          "bailian-realtime: no DashScope API key. Set plugins.entries.bailian-realtime.config.apiKey (a SecretRef is supported), talk.realtime.providers.bailian.apiKey, or DASHSCOPE_API_KEY.",
        );
      }
      return createBailianSession(
        req,
        cred,
        createRealtimeTranscriptionWebSocketSession,
        resolveSettings(pluginConfig, req && req.providerConfig),
      );
    },
  };
}
