import { VoiceConversationState } from "./conversation-state.js";
import {
  findAudibleWindow,
  planAudioPlayback,
} from "./audio-scheduling.js";
import { StreamingSpeechChunker } from "./speech-chunker.js";
import { SpeechSynthesisQueue } from "./speech-synthesis-queue.js";

export function createVoicePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Shiva Voice</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #f5f1ff; background: radial-gradient(circle at 20% 15%, #352263 0, transparent 34%), radial-gradient(circle at 85% 85%, #113d4a 0, transparent 30%), #090b13; display: grid; place-items: center; padding: 24px; }
    main { width: min(760px, 100%); background: rgba(16, 18, 31, .84); border: 1px solid rgba(255,255,255,.1); border-radius: 28px; padding: clamp(22px, 5vw, 42px); box-shadow: 0 28px 80px rgba(0,0,0,.4); backdrop-filter: blur(20px); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
    h1 { margin: 0; font-size: clamp(1.8rem, 5vw, 2.8rem); letter-spacing: -.04em; }
    .eyebrow { margin: 0 0 5px; color: #ac9ae9; font-size: .72rem; font-weight: 750; letter-spacing: .18em; text-transform: uppercase; }
    button { border: 0; color: inherit; font: inherit; cursor: pointer; }
    .secondary { border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 10px 14px; background: rgba(255,255,255,.06); }
    .secondary:hover { background: rgba(255,255,255,.11); }
    .mic-wrap { display: grid; place-items: center; padding: 14px 0 28px; }
    #mic { width: 148px; aspect-ratio: 1; border-radius: 50%; background: linear-gradient(145deg, #8d67ff, #4a2fbb); box-shadow: 0 18px 50px rgba(105,74,225,.4), inset 0 1px rgba(255,255,255,.28); display: grid; place-items: center; transition: transform .18s ease, box-shadow .18s ease; touch-action: none; user-select: none; }
    #mic:hover { transform: translateY(-2px) scale(1.02); }
    #mic.recording { transform: scale(.94); background: linear-gradient(145deg, #ff657d, #c8244b); box-shadow: 0 0 0 12px rgba(255,76,112,.12), 0 18px 55px rgba(204,36,75,.4); animation: pulse 1.4s infinite; }
    #mic:disabled { opacity: .45; cursor: not-allowed; }
    #mic svg { width: 48px; height: 48px; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 20px rgba(255,76,112,.04), 0 18px 55px rgba(204,36,75,.38); } }
    #status { min-height: 24px; text-align: center; color: #bdb6d5; margin: 0 0 22px; }
    #status.error { color: #ff9dae; }
    .panel { background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.08); border-radius: 17px; padding: 16px 18px; margin-top: 12px; }
    .label { color: #8f87aa; font-size: .7rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; margin-bottom: 7px; }
    .copy { min-height: 24px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .placeholder { color: #68647a; }
    form { display: flex; gap: 10px; margin-top: 18px; }
    input { min-width: 0; flex: 1; border: 1px solid rgba(255,255,255,.12); border-radius: 13px; padding: 13px 15px; color: #fff; background: rgba(4,5,10,.5); font: inherit; outline: none; }
    input:focus { border-color: #8669e8; box-shadow: 0 0 0 3px rgba(134,105,232,.15); }
    .send { border-radius: 13px; padding: 0 18px; background: #7559d7; font-weight: 750; }
    .controls { display: flex; align-items: center; gap: 10px; margin-top: 15px; }
    audio { flex: 1; height: 38px; min-width: 0; }
    .hint { color: #716b85; text-align: center; font-size: .78rem; margin: 14px 0 0; }
    @media (max-width: 560px) { header { align-items: flex-start; } .controls { flex-wrap: wrap; } audio { flex-basis: 100%; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><p class="eyebrow">Private personal AI</p><h1>Talk with Shiva</h1></div>
      <button id="newConversation" class="secondary" type="button">New conversation</button>
    </header>
    <div class="mic-wrap">
      <button id="mic" type="button" aria-label="Hold to talk" title="Hold to talk">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4M8.5 21h7"></path></svg>
      </button>
    </div>
    <p id="status" role="status" aria-live="polite">Hold the microphone to speak</p>
    <section class="panel"><div class="label">You</div><div id="transcription" class="copy placeholder">Your words will appear here.</div></section>
    <section class="panel"><div class="label">Shiva</div><div id="response" class="copy placeholder">Shiva's answer will stream here.</div></section>
    <form id="typedForm"><input id="typedInput" maxlength="20000" autocomplete="off" placeholder="Or type a message…" aria-label="Message"><button class="send" type="submit">Send</button></form>
    <div class="controls"><button id="stopSpeaking" class="secondary" type="button">Stop speaking</button><audio id="audio" controls></audio></div>
    <p class="hint">Conversation continuity is kept only for this browser tab.</p>
  </main>
  <script>${createVoiceClientScript()}</script>
</body>
</html>`;
}

export function createVoiceClientScript(): string {
  return [
    `const VoiceConversationState = ${VoiceConversationState.toString()};`,
    `const StreamingSpeechChunker = ${StreamingSpeechChunker.toString()};`,
    `const SpeechSynthesisQueue = ${SpeechSynthesisQueue.toString()};`,
    `const planAudioPlayback = ${planAudioPlayback.toString()};`,
    `const findAudibleWindow = ${findAudibleWindow.toString()};`,
  ].join("\n") + String.raw`
(() => {
  "use strict";
  const conversation = new VoiceConversationState(sessionStorage);
  const mic = document.getElementById("mic");
  const status = document.getElementById("status");
  const transcription = document.getElementById("transcription");
  const responseText = document.getElementById("response");
  const typedForm = document.getElementById("typedForm");
  const typedInput = document.getElementById("typedInput");
  const audio = document.getElementById("audio");
  const stopButton = document.getElementById("stopSpeaking");
  const newButton = document.getElementById("newConversation");

  let recorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let pressHeld = false;
  let chatController = null;
  let audioContext = null;
  let speechSession = null;

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  function setCopy(element, value) {
    element.textContent = value;
    element.classList.toggle("placeholder", value.length === 0);
  }

  function selectedMimeType() {
    const choices = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    return choices.find((choice) => MediaRecorder.isTypeSupported(choice)) || "";
  }

  function primeAudio() {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      audio.hidden = false;
      return;
    }
    try {
      if (!audioContext) {
        audioContext = new AudioContextConstructor({ latencyHint: "interactive" });
      }
      audio.hidden = true;
      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => {
          audio.hidden = false;
        });
      }
    } catch {
      audioContext = null;
      audio.hidden = false;
    }
  }

  async function startRecording() {
    if (recorder && recorder.state === "recording") return;
    primeAudio();
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setStatus("This browser does not support microphone recording. Use typed input.", true);
      return;
    }
    try {
      setStatus("Requesting microphone…");
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = selectedMimeType();
      recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
      recordedChunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) recordedChunks.push(event.data);
      });
      recorder.addEventListener("stop", handleRecording);
      recorder.start();
      mic.classList.add("recording");
      setStatus("Listening… release to send");
      if (!pressHeld) stopRecording();
    } catch (error) {
      stopMediaTracks();
      setStatus(error instanceof Error ? error.message : "Microphone access failed.", true);
    }
  }

  function stopRecording() {
    if (recorder && recorder.state === "recording") recorder.stop();
    mic.classList.remove("recording");
    stopMediaTracks();
  }

  function stopMediaTracks() {
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  async function handleRecording() {
    const type = recorder && recorder.mimeType ? recorder.mimeType : "audio/webm";
    const blob = new Blob(recordedChunks, { type });
    recorder = null;
    if (blob.size === 0) {
      setStatus("No audio was recorded. Please try again.", true);
      return;
    }
    const turnId = crypto.randomUUID();
    try {
      setStatus("Transcribing…");
      const result = await fetch("/voice/transcribe", {
        method: "POST",
        headers: { "content-type": type, "x-shiva-voice-turn-id": turnId },
        body: blob,
      });
      if (!result.ok) throw new Error(await publicError(result));
      const transcript = await result.json();
      setCopy(transcription, transcript.text);
      await runChat(transcript.text, turnId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Voice transcription failed.", true);
    }
  }

  async function runChat(message, turnId) {
    if (!message || !message.trim()) return;
    stopSpeaking();
    if (chatController) chatController.abort();
    chatController = new AbortController();
    const session = createSpeechSession(turnId);
    speechSession = session;
    setCopy(transcription, message);
    setCopy(responseText, "");
    setStatus("Shiva is thinking…");

    try {
      const result = await fetch("/voice/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shiva-voice-turn-id": turnId },
        body: JSON.stringify(conversation.chatPayload(message)),
        signal: chatController.signal,
      });
      if (!result.ok) throw new Error(await publicError(result));
      conversation.captureResponse(result.headers);
      if (!result.body) throw new Error("Shiva returned an empty stream.");

      const reader = result.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const text = decoder.decode(part.value, { stream: true });
          fullResponse += text;
          setCopy(responseText, fullResponse);
          queueSpeechChunks(session, session.chunker.push(text));
          setStatus("Shiva is replying…");
        }
        const tail = decoder.decode();
        fullResponse += tail;
        setCopy(responseText, fullResponse);
        queueSpeechChunks(session, session.chunker.push(tail));
        queueSpeechChunks(session, session.chunker.finish());
        session.chatFinished = true;
        maybeFinishSpeech(session);
        if (!session.idleReported) setStatus("Shiva is speaking…");
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      cancelSpeechSession(session);
      throw error;
    }
  }

  function createSpeechSession(turnId) {
    const session = {
      turnId,
      chunker: new StreamingSpeechChunker(),
      queue: null,
      nextSequence: 0,
      unsettledChunks: 0,
      settledSequences: new Set(),
      sources: new Set(),
      playbackTimers: new Set(),
      scheduledUntil: null,
      fallbackQueue: [],
      fallbackPlaying: false,
      currentFallbackUrl: null,
      telemetryTail: Promise.resolve(),
      chatFinished: false,
      cancelled: false,
      idleReported: false,
    };
    session.queue = new SpeechSynthesisQueue({
      worker: (item, signal) => synthesizeSpeech(session, item, signal),
      onReady: async (item, wav, signal) => {
        try {
          if (!session.cancelled && !signal.aborted) {
            await scheduleSpeech(session, item, wav, signal);
          }
        } finally {
          settleSpeechChunk(session, item.sequence);
        }
      },
      onError: (error, item) => {
        settleSpeechChunk(session, item.sequence);
        if (!session.cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
          setStatus(error instanceof Error ? error.message : "Speech synthesis failed.", true);
        }
      },
      onIdle: () => maybeFinishSpeech(session),
    });
    return session;
  }

  function queueSpeechChunks(session, chunks) {
    for (const text of chunks) {
      if (session.cancelled || !text.trim()) continue;
      const item = {
        sequence: session.nextSequence++,
        text: text.trim(),
        textReadyAt: Date.now(),
      };
      session.unsettledChunks += 1;
      if (!session.queue.enqueue(item)) {
        settleSpeechChunk(session, item.sequence);
      }
    }
  }

  async function synthesizeSpeech(session, item, signal) {
    const result = await fetch("/voice/synthesize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shiva-voice-turn-id": session.turnId,
        "x-shiva-voice-sequence": String(item.sequence),
        "x-shiva-text-ready-at": String(item.textReadyAt),
      },
      body: JSON.stringify({ text: item.text }),
      signal,
    });
    if (!result.ok) throw new Error(await publicError(result));
    return result.arrayBuffer();
  }

  async function scheduleSpeech(session, item, wav, signal) {
    if (audioContext) {
      try {
        if (audioContext.state === "suspended") await audioContext.resume();
        const buffer = await audioContext.decodeAudioData(wav.slice(0));
        if (session.cancelled || signal.aborted) return;
        scheduleAudioBuffer(session, item.sequence, buffer);
        return;
      } catch (error) {
        if (session.cancelled || signal.aborted) return;
        console.warn("[SHIVA VOICE] Web Audio decoding failed; using HTML audio fallback.", error);
        audio.hidden = false;
      }
    }

    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    session.fallbackQueue.push({ sequence: item.sequence, url });
    void playFallbackQueue(session);
  }

  function scheduleAudioBuffer(session, sequence, buffer) {
    const channels = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel));
    }
    const audible = findAudibleWindow(channels, buffer.sampleRate);
    if (audible.durationSeconds <= 0) return;

    const plan = planAudioPlayback(
      audioContext.currentTime,
      session.scheduledUntil,
      audible.durationSeconds,
    );
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    session.sources.add(source);
    session.scheduledUntil = plan.endAt;
    source.addEventListener("ended", () => {
      session.sources.delete(source);
      if (!session.cancelled) {
        reportPlayback(session, "ended", sequence);
        maybeFinishSpeech(session);
      }
    }, { once: true });
    source.start(plan.startAt, audible.offsetSeconds, audible.durationSeconds);
    reportPlayback(session, "scheduled", sequence);
    const startDelayMs = Math.max(0, (plan.startAt - audioContext.currentTime) * 1_000);
    const startTimer = window.setTimeout(() => {
      session.playbackTimers.delete(startTimer);
      if (!session.cancelled) reportPlayback(session, "started", sequence);
    }, startDelayMs);
    session.playbackTimers.add(startTimer);
    if (plan.underrunMs > 50) {
      console.warn("[SHIVA VOICE UNDERRUN]", {
        turnId: session.turnId,
        sequence,
        underrunMs: Math.round(plan.underrunMs),
      });
    }
    setStatus("Shiva is speaking…");
  }

  async function playFallbackQueue(session) {
    if (session.fallbackPlaying || session.cancelled) return;
    session.fallbackPlaying = true;
    try {
      while (!session.cancelled && session.fallbackQueue.length > 0) {
        const item = session.fallbackQueue.shift();
        if (!item) break;
        audio.src = item.url;
        session.currentFallbackUrl = item.url;
        let played = false;
        try {
          reportPlayback(session, "scheduled", item.sequence);
          await audio.play();
          played = true;
          reportPlayback(session, "started", item.sequence);
          setStatus("Shiva is speaking…");
          await new Promise((resolve) => {
            const finish = () => {
              audio.removeEventListener("ended", finish);
              audio.removeEventListener("error", finish);
              audio.removeEventListener("pause", finish);
              resolve();
            };
            audio.addEventListener("ended", finish, { once: true });
            audio.addEventListener("error", finish, { once: true });
            audio.addEventListener("pause", finish, { once: true });
          });
          if (!session.cancelled) reportPlayback(session, "ended", item.sequence);
        } catch {
          if (!session.cancelled) {
            setStatus("Audio is ready. Press play to hear Shiva.");
          }
          return;
        } finally {
          if (played || session.cancelled) {
            URL.revokeObjectURL(item.url);
            if (session.currentFallbackUrl === item.url) session.currentFallbackUrl = null;
          }
        }
      }
    } finally {
      session.fallbackPlaying = false;
      maybeFinishSpeech(session);
    }
  }

  function settleSpeechChunk(session, sequence) {
    if (session.settledSequences.has(sequence)) return;
    session.settledSequences.add(sequence);
    session.unsettledChunks = Math.max(0, session.unsettledChunks - 1);
    maybeFinishSpeech(session);
  }

  function maybeFinishSpeech(session) {
    if (
      session.cancelled ||
      !session.chatFinished ||
      session.unsettledChunks > 0 ||
      session.sources.size > 0 ||
      session.fallbackPlaying ||
      session.fallbackQueue.length > 0
    ) {
      return;
    }
    reportPlaybackIdle(session);
    if (speechSession === session) setStatus("Ready");
  }

  function reportPlayback(session, event, sequence) {
    if (session.cancelled || session.idleReported) return;
    queuePlaybackTelemetry(session, { event, sequence, timestampMs: Date.now() });
  }

  function reportPlaybackIdle(session) {
    if (session.idleReported) return;
    session.idleReported = true;
    queuePlaybackTelemetry(session, { event: "idle", timestampMs: Date.now() });
  }

  function queuePlaybackTelemetry(session, payload) {
    session.telemetryTail = session.telemetryTail.then(async () => {
      try {
        await fetch("/voice/playback", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shiva-voice-turn-id": session.turnId,
          },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch {
        // Playback must not depend on optional telemetry delivery.
      }
    });
  }

  function cancelSpeechSession(session) {
    if (!session || session.cancelled) return;
    session.cancelled = true;
    session.chunker.reset();
    session.queue.cancel();
    session.playbackTimers.forEach((timer) => window.clearTimeout(timer));
    session.playbackTimers.clear();
    session.sources.forEach((source) => {
      try { source.stop(); } catch { /* Source may already have ended. */ }
    });
    session.sources.clear();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (session.currentFallbackUrl) URL.revokeObjectURL(session.currentFallbackUrl);
    session.currentFallbackUrl = null;
    session.fallbackQueue.forEach((item) => URL.revokeObjectURL(item.url));
    session.fallbackQueue = [];
    session.fallbackPlaying = false;
    reportPlaybackIdle(session);
  }

  function stopSpeaking() {
    const session = speechSession;
    if (session) cancelSpeechSession(session);
    speechSession = null;
  }

  async function publicError(result) {
    try {
      const payload = await result.json();
      return payload.error && payload.error.message ? payload.error.message : "Request failed.";
    } catch {
      return "Request failed.";
    }
  }

  mic.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    pressHeld = true;
    mic.setPointerCapture(event.pointerId);
    primeAudio();
    void startRecording();
  });
  mic.addEventListener("pointerup", () => { pressHeld = false; stopRecording(); });
  mic.addEventListener("pointercancel", () => { pressHeld = false; stopRecording(); });
  typedForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = typedInput.value.trim();
    if (!message) return;
    primeAudio();
    typedInput.value = "";
    void runChat(message, crypto.randomUUID()).catch((error) => {
      setStatus(error instanceof Error ? error.message : "Chat failed.", true);
    });
  });
  stopButton.addEventListener("click", stopSpeaking);
  newButton.addEventListener("click", () => {
    if (chatController) chatController.abort();
    stopSpeaking();
    conversation.clear();
    setCopy(transcription, "");
    setCopy(responseText, "");
    setStatus("New conversation started");
  });
  window.addEventListener("pagehide", () => {
    if (speechSession) cancelSpeechSession(speechSession);
  });
})();`;
}
