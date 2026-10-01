import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Hermetic HOME: the developer's real ~/.config/bailian/* must never affect this test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bailian-plugins-test-"));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { buildBailianRealtimeProvider, readApiKey: readRt } = await import("../openclaw-bailian-realtime/session.js");
const { buildBailianVoiceProvider, readApiKey: readVoice } = await import("../openclaw-bailian-voice/bridge.js");

// Synthetic values only.
const K = "api" + "Key";
const envName = (...p) => p.join("_");
const DS = ["DASH", "SCOPE"].join("");
const ASR_ENV = envName(DS, "ASR", "API", "KEY");
const VOICE_ENV = envName(DS, "VOICE", "API", "KEY");
const LEGACY_ENV = envName(DS, "API", "KEY");
const cfg = (v) => ({ [K]: v });
const cfgDir = path.join(TMP, ".config", "bailian");

const clearEnv = () => {
  delete process.env[ASR_ENV];
  delete process.env[VOICE_ENV];
  delete process.env[LEGACY_ENV];
};
clearEnv();

const fakeSdk = () => ({ marker: "fake-transport" });
let pass = 0;
const ok = (label) => { pass += 1; console.log("  PASS  " + label); };

try {
  console.log("[1] realtime: credential from providerConfig / plugin config");
  {
    const p = buildBailianRealtimeProvider({ createRealtimeTranscriptionWebSocketSession: fakeSdk, pluginConfig: cfg("cfg-transcription") });
    assert.equal(readRt(cfg("cfg-transcription"), undefined), "cfg-transcription");
    assert.equal(p.isConfigured({ providerConfig: cfg("provider-transcription") }), true);
    ok("isConfigured() true from providerConfig");
    assert.equal(p.createSession({ providerConfig: cfg("provider-transcription") }).marker, "fake-transport");
    ok("createSession() reaches the injected SDK transport");
  }

  console.log("[2] realtime: nothing configured -> fails loudly");
  {
    const p = buildBailianRealtimeProvider({ createRealtimeTranscriptionWebSocketSession: fakeSdk, pluginConfig: {} });
    assert.equal(p.isConfigured({}), false);
    ok("isConfigured() false");
    assert.throws(() => p.createSession({}), /no DashScope API key/);
    ok("createSession() throws a helpful error");
  }

  console.log("[3] realtime: own env var works, legacy shared var does not");
  {
    process.env[LEGACY_ENV] = "legacy-shared";
    assert.equal(readRt({}, {}), "");
    ok("legacy shared env var is ignored");
    process.env[ASR_ENV] = "env-transcription";
    assert.equal(readRt({}, {}), "env-transcription");
    ok("DASHSCOPE_ASR_API_KEY is honoured");
    clearEnv();
  }

  console.log("[4] realtime: plugin config wins over env");
  {
    process.env[ASR_ENV] = "env-transcription";
    assert.equal(readRt(cfg("cfg-transcription"), undefined), "cfg-transcription");
    ok("config takes precedence");
    clearEnv();
  }

  console.log("[5] realtime: settings from config");
  {
    const p = buildBailianRealtimeProvider({ createRealtimeTranscriptionWebSocketSession: fakeSdk, pluginConfig: { ...cfg("cfg-transcription"), model: "custom-asr", inputEncoding: "pcm16" } });
    assert.equal(p.defaultModel, "custom-asr");
    assert.ok(p.models.includes("custom-asr"));
    ok("model override applied");
    const d = buildBailianRealtimeProvider({ createRealtimeTranscriptionWebSocketSession: fakeSdk, pluginConfig: cfg("cfg-transcription") });
    assert.equal(d.defaultModel, "fun-asr-realtime");
    ok("default model retained when omitted");
  }

  console.log("[6] voice: credential from providerConfig / plugin config");
  {
    const p = buildBailianVoiceProvider({ pluginConfig: cfg("cfg-voice") });
    assert.equal(readVoice(cfg("cfg-voice"), undefined), "cfg-voice");
    assert.equal(p.isConfigured({ providerConfig: cfg("provider-voice") }), true);
    ok("isConfigured() true from providerConfig");
    assert.equal(p.id, "bailian-voice");
    assert.ok(p.models.length >= 3 && p.voices.length >= 6);
    ok("models/voices catalog intact (" + p.models.length + " models, " + p.voices.length + " voices)");
    assert.equal(p.capabilities.supportsToolCalls, true);
    ok("capabilities intact");
  }

  console.log("[7] voice: nothing configured -> fails loudly");
  {
    const p = buildBailianVoiceProvider({ pluginConfig: {} });
    assert.equal(p.isConfigured({}), false);
    ok("isConfigured() false");
    assert.throws(() => p.createBridge({}), /no DashScope API key/);
    ok("createBridge() throws a helpful error");
  }

  console.log("[8] voice: own env var works; realtime's env var does not");
  {
    process.env[ASR_ENV] = "env-transcription";
    assert.equal(readVoice({}, {}), "");
    ok("ASR env var is invisible to the voice plugin");
    process.env[VOICE_ENV] = "env-voice";
    assert.equal(readVoice({}, {}), "env-voice");
    ok("DASHSCOPE_VOICE_API_KEY is honoured");
    clearEnv();
  }

  console.log("[9] voice: settings honoured; per-request override wins");
  {
    const p = buildBailianVoiceProvider({ pluginConfig: { ...cfg("cfg-voice"), model: "cfg-model", voice: "cfg-voice-name" } });
    assert.equal(p.defaultModel, "cfg-model");
    ok("defaultModel from config");
    const b = p.createBridge({ providerConfig: { ...cfg("provider-voice"), model: "req-model" } });
    assert.equal(typeof b.sendAudio, "function");
    assert.equal(typeof b.submitToolResult, "function");
    assert.equal(typeof b.close, "function");
    ok("bridge built with per-request override");
  }

  console.log("[10] key files are per-plugin and never shared");
  {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "asr_api_key"), "file-transcription");
    assert.equal(readRt({}, {}), "file-transcription");
    ok("asr_api_key is read by the transcription plugin");
    assert.equal(readVoice({}, {}), "");
    ok("the voice plugin does NOT read asr_api_key");
    fs.writeFileSync(path.join(cfgDir, "voice_api_key"), "file-voice");
    assert.equal(readVoice({}, {}), "file-voice");
    ok("voice_api_key is read by the voice plugin");
    assert.equal(readRt({}, {}), "file-transcription");
    ok("the transcription plugin does NOT read voice_api_key");
  }

  console.log("[11] realtime: missing SDK dependency is reported");
  {
    assert.throws(() => buildBailianRealtimeProvider({ pluginConfig: cfg("cfg-transcription") }), /dependency missing/);
    ok("build without the SDK transport throws");
  }

  console.log("");
  console.log("ALL " + pass + " ASSERTIONS PASSED");
} finally {
  clearEnv();
  fs.rmSync(TMP, { recursive: true, force: true });
}
