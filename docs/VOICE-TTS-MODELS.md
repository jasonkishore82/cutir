# Voice assistant: speech pipeline and low-latency TTS models

Cutir can be driven by voice: you talk, it edits the video, and it answers out loud. This document explains how that works, what is built, and which text-to-speech (TTS) models are good choices for low latency.

> **Numbers in this document are reported by third parties** (model authors, vendor and community blogs), not measured by us. Latency depends heavily on hardware, so benchmark on your own machine before choosing. Items we could not verify are marked as such.

## 1. The pipeline ("speech to speech")

```
 microphone ──► STT ──────► LLM ───────► TTS ──────► speaker
            Web Speech    Ollama       sentence by
               API       (tool calls)   sentence
```

It is a *cascade* (three stages), not one end-to-end speech model. That suits Cutir: the middle stage is the existing chat, so a spoken request runs the same tools as a typed one ("use Roboto font", "shift lines 4 to 8 by half a second", "auto sync").

| Stage | What we use | Where it runs |
|---|---|---|
| **STT** (speech to text) | Browser **Web Speech API** (`SpeechRecognition`) | Browser. In Chrome the default recognizer sends audio to Google's speech service; see section 2 |
| **LLM** | Ollama (qwen3, qwen2.5-coder, llama3.1, ...) | Your machine |
| **TTS** (text to speech) | Browser `speechSynthesis` today; a local neural model is the upgrade path | Your machine |

### What is built

- **Mic button** in the chat box (top-right corner). Live text appears in the box while you talk; the finished sentence is sent automatically.
- **Read replies aloud** (speaker button) and **hands-free conversation** (the mic turns back on after each reply).
- **Sentence streaming:** the reply is spoken sentence by sentence *while the model is still writing*, so time-to-first-audio is the first sentence, not the whole answer.
- **Barge-in:** pressing the mic (or the stop button) interrupts speech immediately. While Cutir speaks, the microphone is off to avoid an echo loop.
- **Spoken confirmations** for edits ("Done, font Roboto."). Hex codes, JSON and tool calls are never read out.
- **Settings** behind the gear icon: language, voice, speed, on-device recognition.
- Code: `src/lib/voice/` (`stt.ts`, `tts.ts`, `index.ts`), `src/store/voice.ts`, `src/components/Composer.tsx`, `src/components/ChatSettings.tsx`.

## 2. Speech-to-text: Web Speech API

- **Supported:** Chrome, Edge and Safari have it; Firefox does not. Check [MDN's compatibility table](https://developer.mozilla.org/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API) before relying on it.
- **Needs** a secure context (localhost or HTTPS) and microphone permission.
- **Privacy:** by default Chrome does **not** recognize speech on your device; it sends the audio to Google's speech service. `SpeechRecognition.processLocally` asks the browser to keep audio on the device, but it is experimental, off by default, and needs the language installed. MDN states that with it neither the audio nor the transcript goes to a third-party service. Microsoft documents a similar on-device option for Edge. Cutir exposes this as **"Keep speech on this device"** in the gear menu. We did not independently verify what leaves the device in each browser.
- **Offline:** the default mode needs internet.
- **Why it fits:** zero install, fast endpointing, interim results for live text. **Trade-offs:** you do not control the model, accuracy varies by accent and language, and there are no word timings.
- **If you need fully local STT later:** Whisper-class models via the Python backend or in the browser (WASM/WebGPU) are the usual route.

## 3. Latency budget

A natural-feeling exchange needs roughly **under 1 to 1.5 seconds** from the end of your sentence to the first spoken word. Where the time goes:

| Step | Typical contributor | What helps |
|---|---|---|
| End of speech detected | Browser endpointing (a few hundred ms) | Nothing to tune in Web Speech |
| LLM first tokens | Model size, GPU, prompt length | Keep the model loaded; short prompts; tool groups |
| TTS first audio | Model and hardware | A fast TTS model (section 4); start on the **first sentence** |
| Playback start | Audio output buffering | Small buffers |

Biggest wins, already built: **sentence streaming** and **starting TTS before the LLM finishes**. Next: keep the TTS model warm and pre-synthesize the next sentence while the current one plays.

## 4. TTS model options

| Model | Size / license | Reported latency | Runs where | Notes |
|---|---|---|---|---|
| **Browser `speechSynthesis`** (built) | Built into the browser | Starts almost instantly (local voices) | Browser/OS | No setup. Voice quality depends on the OS; some browsers offer online voices that send text to a vendor. |
| **Kokoro-82M** | 82M params, Apache 2.0 | No official streaming figure; community numbers conflict (see below) | CPU; also in-browser via `kokoro-js` (WASM or WebGPU) | Best size-to-quality for local use. Apache-licensed. Our suggested first upgrade. |
| **Orpheus 3B** (Canopy Labs) | 3B params (Llama backbone) | About 200 ms streaming, about 100 ms with input streaming (reported) | GPU | English main models; multilingual models are a research preview. Expressive. |
| **Qwen3-TTS** | Apache 2.0 | About 97 ms streaming (claimed) | GPU | Frequently cited for real-time agents. Verify on your hardware. |
| **Chatterbox-Turbo** | MIT | About 75 ms (reported, single consumer **GPU**) | GPU | A Picovoice CPU benchmark measured about **48 s** to first audio on CPU and noted it needs the full audio before playing, so **do not run it on CPU**. |
| **CosyVoice 2** | Apache 2.0 | About 150 ms streaming (its own account) | GPU | Streaming support; multilingual. |
| **Kyutai Pocket TTS** | 100M params, CC BY 4.0 | 250 to 430 ms first audio on an M2 CPU (reported) | CPU | Voice cloning from a short recording. Not the tightest latency. |
| **Piper** | Small ONNX voices | Runs in real time on CPU and on a Raspberry Pi (no measured figure found) | CPU | **License is unclear:** newer sources list GPL-3.0, older ones MIT. Check before shipping in a product. |
| *Cartesia Sonic* (hosted, not open) | Commercial API | Under 90 ms to first audio (vendor claim) | Cloud | Only for comparison; it sends text to a third party. |

### Browser Kokoro speed: sources disagree

Third-party reports for `kokoro-js` range from about **1.5 to 2 times real time on WebGPU** (Apple M4) to **0.5 to 1 times real time on WASM/CPU**, and one table lists a real-time factor of 0.2 to 0.4 on an M2 with WebGPU. These use different units (multiples of real time versus RTF, its inverse) and different machines, so they are not comparable. Model download size is quoted as about 82 MB by one source and about 300 MB by another. Measure it.

## 5. Recommendation for Cutir

Cutir's typical setup (a desktop with a discrete GPU running Ollama, plus the optional Python backend):

1. **Now: browser voices** (done). Zero setup, near-instant start, good enough to prove the experience.
2. **Next: Kokoro-82M** for a consistent, nicer, fully local voice. Two ways:
   - **In the browser** with `kokoro-js` (no backend, works offline after the first model download; speed depends on WebGPU).
   - **In the Python backend** as `POST /api/tts` that streams audio per sentence. Keeps the browser light and works the same in every browser. Note the backend's PyTorch is currently the CPU build; a CPU Kokoro is plausible, but measure it.
3. **Optional: a GPU model** (Orpheus 3B or Qwen3-TTS) if you want the lowest latency and the most expressive voice, and you are happy to run a CUDA PyTorch environment next to Ollama. Both will share GPU memory with your LLM, so check VRAM headroom. This needs a CUDA build of PyTorch; on the development machine a Windows application-control policy had blocked a torch DLL before, so confirm it loads.

Avoid CPU-only runs of GPU-class models (Chatterbox, Orpheus).

## 6. How to add a TTS provider

`src/lib/voice/tts.ts` defines the interface:

```ts
interface TTSProvider {
  speak(text: string, opts: { lang: string; voiceURI: string; rate: number }): Promise<void>; // resolves when finished or cancelled
  cancel(): void;
}
```

The `Speaker` queue feeds it one sentence at a time and calls `cancel()` on barge-in. To add Kokoro: implement `speak` (synthesize, play via Web Audio, resolve on end), then `speaker.setProvider(...)`. To cut latency further, start synthesizing sentence N+1 while sentence N is still playing; the queue is the place to add that.

## 7. How to benchmark on your machine

Measure **time to first audio**: from the moment the first sentence is complete to the first sample being played. Try 10 short replies per candidate model, warm (model already loaded), and report the median and the worst case. Also note GPU memory used while the LLM is loaded. Pick the model with the best median that still sounds good at your reply length.

## Sources

- [The Best Open-Source Text-to-Speech Models in 2026 (BentoML)](https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models)
- [Best open-source TTS models, compared by license (Cartesia)](https://www.cartesia.ai/learn/open-source-tts)
- [Best Open Source Text to Speech Models in 2026: 10 Ranked (micdrop)](https://micdrop.dev/blog/top-open-source-text-to-speech-models)
- [Best Open Source Self-Hosted Text-to-Speech Models in 2026 (Pinggy)](https://pinggy.io/blog/best_open_source_self_hosted_text_to_speech_models/)
- [Browser TTS Showdown: Kokoro vs Piper vs Kitten, 2026 Benchmark](https://offlinetts.com/blog/browser-tts-showdown-kokoro-piper-kitten/)
- [Running Kokoro-82M ONNX TTS in the browser (DEV Community)](https://dev.to/emojiiii/running-kokoro-82m-onnx-tts-model-in-the-browser-eeh)
- [kokoro-js README](https://cdn.jsdelivr.net/npm/kokoro-js@1.2.0/README.md)
- [On-device TTS benchmark (Picovoice)](https://picovoice.ai/docs/benchmark/tts/) and [Picovoice on-device TTS article](https://picovoice.ai/blog/on-device-tts/)
- [Piper vs Chatterbox TTS (PromptQuorum)](https://www.promptquorum.com/power-local-llm/piper-vs-chatterbox-tts)
- [SpeechRecognition: processLocally (MDN)](https://developer.mozilla.org/docs/Web/API/SpeechRecognition/processLocally)
- [Using the Web Speech API (MDN)](https://developer.mozilla.org/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
- [Speech recognition API in Edge (Microsoft)](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)
- [Intent to Ship: Web Speech API on-device recognition (Chromium blink-dev)](https://groups.google.com/a/chromium.org/g/blink-dev/c/P8P-x7AnC6I)
