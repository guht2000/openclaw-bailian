# openclaw-bailian-voice

Bailian (Aliyun DashScope) **Qwen-Audio-Realtime** voice provider for OpenClaw Talk.

Registers a `realtimeVoiceProvider` with id `bailian-voice`: full-duplex
speech-to-speech, server VAD, barge-in, and tool calls.

## Requirements

- OpenClaw `>=2026.9.7`
- A DashScope (Bailian) API key: <https://bailian.console.aliyun.com/>

## Install

    openclaw plugins install clawhub:@guht2000/openclaw-bailian-voice

## Configure

Credentials live in plugin config, so they can be a **SecretRef** instead of a
plaintext value. OpenClaw resolves the reference before the plugin sees it.

    # plain value (written to the config file)
    openclaw config set plugins.entries.bailian-voice.config.apiKey "sk-..."

    # or a SecretRef (recommended: no secret in the config file)
    openclaw config set plugins.entries.bailian-voice.config.apiKey --ref-provider default --ref-source store --ref-id DASHSCOPE_API_KEY

Alternatively set the `DASHSCOPE_API_KEY` (or `BAILIAN_API_KEY`) environment
variable. Plugin config takes precedence over the environment.

### Settings

| Config key | Env fallback | Default |
| --- | --- | --- |
| `apiKey` | `DASHSCOPE_API_KEY`, `BAILIAN_API_KEY` | — (required) |
| `baseUrl` | `BAILIAN_REALTIME_BASE` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` |
| `model` | `BAILIAN_VOICE_MODEL` | `qwen-audio-3.1-realtime-plus` |
| `voice` | `BAILIAN_VOICE_NAME` | `longanqian` |

Models: `qwen-audio-3.1-realtime-plus`, `qwen-audio-3.0-realtime-plus`,
`qwen-audio-3.0-realtime-flash`.

Voices: `longanqian`, `longanlingxin`, `longanlufeng`, `longanlingxi`,
`longanfengyue`, `loongmary`.

## Notes

- PCM16 @ 24 kHz in and out; 8 kHz mu-law input is resampled to 16 kHz.
- Server VAD (threshold 0.5, 700 ms silence) drives turn taking.
- Tool calls supported via `onToolCall` / `submitToolResult`.
- Transport is gateway relay only (`supportsBrowserSession: false`).
- A per-request `providerConfig.model` / `.voice` overrides the plugin defaults.

## License

MIT
