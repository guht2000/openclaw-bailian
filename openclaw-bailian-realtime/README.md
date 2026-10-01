# openclaw-bailian-realtime

Bailian (Aliyun DashScope) **realtime speech-to-text** for OpenClaw Talk.

Registers a `realtimeTranscriptionProvider` with id `bailian`, so Talk's
dictation / realtime transcription can use Alibaba's streaming ASR.

## Requirements

- OpenClaw `>=2026.9.7`
- A DashScope (Bailian) API key: <https://bailian.console.aliyun.com/>

## Install

    openclaw plugins install clawhub:@guht2000/openclaw-bailian-realtime

## Configure

Credentials live in plugin config, so they can be a **SecretRef** instead of a
plaintext value. OpenClaw resolves the reference before the plugin sees it.

    # plain value (written to the config file)
    openclaw config set plugins.entries.bailian-realtime.config.apiKey "sk-..."

    # or a SecretRef (recommended: no secret in the config file)
    openclaw config set plugins.entries.bailian-realtime.config.apiKey --ref-provider default --ref-source store --ref-id DASHSCOPE_API_KEY

Alternatively set the `DASHSCOPE_API_KEY` (or `BAILIAN_API_KEY`) environment
variable. Plugin config takes precedence over the environment.

### Settings

| Config key | Env fallback | Default |
| --- | --- | --- |
| `apiKey` | `DASHSCOPE_API_KEY`, `BAILIAN_API_KEY` | — (required) |
| `url` | `BAILIAN_REALTIME_URL` | `wss://dashscope.aliyuncs.com/api-ws/v1/inference` |
| `model` | `BAILIAN_REALTIME_MODEL` | `fun-asr-realtime` |
| `inputEncoding` | `BAILIAN_REALTIME_INPUT_ENCODING` | `g711_ulaw` (use `pcm16` for raw PCM) |

Models offered: `fun-asr-realtime`, `qwen-audio-3.1-asr-flash-streaming`.

## Notes

- Input is 8 kHz mono. G.711 mu-law is decoded to PCM16 in-process.
- Uses OpenClaw's `createRealtimeTranscriptionWebSocketSession` transport helper.
- When no credential is configured, `isConfigured()` is false and
  `createSession()` throws a message naming both the config path and the env var.

## License

MIT
