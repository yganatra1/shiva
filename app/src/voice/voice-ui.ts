import {
  findAudibleWindow,
  planAudioPlayback,
} from "./audio-scheduling";
import { decodeVoiceAudioFrame } from "./audio-frame";
import { VoiceAudioPlayer } from "./client/voice-audio-player";
import { VoiceSocketClient } from "./client/voice-socket-client";
import { VoiceConversationState } from "./conversation-state";

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
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    h1 { margin: 0; font-size: clamp(1.6rem, 4.4vw, 2.4rem); letter-spacing: -.04em; }
    .eyebrow { margin: 0 0 5px; color: #ac9ae9; font-size: .72rem; font-weight: 750; letter-spacing: .18em; text-transform: uppercase; }
    button { border: 0; color: inherit; font: inherit; cursor: pointer; }
    .secondary { border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 10px 14px; color: inherit; background: rgba(255,255,255,.06); text-decoration: none; }
    .secondary:hover { background: rgba(255,255,255,.11); }
    .statusbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; font-size: .82rem; }
    #phase { display: inline-flex; align-items: center; gap: 8px; color: #d6cffb; font-weight: 700; }
    #phase::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: #8d67ff; }
    #phase[data-phase="listening"]::before { background: #ff657d; }
    #phase[data-phase="speaking"]::before { background: #4ad6a4; }
    #phase[data-phase="thinking"]::before, #phase[data-phase="transcribing"]::before { background: #f2c14b; }
    #connection { color: #8f87aa; }
    #connection[data-state="reconnecting"], #connection[data-state="connecting"] { color: #f2c14b; }
    #connection[data-state="closed"] { color: #ff9dae; }
    #transcript { display: flex; flex-direction: column; gap: 10px; max-height: 46vh; overflow-y: auto; padding: 14px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 17px; }
    .turn { display: flex; flex-direction: column; gap: 3px; }
    .turn .who { color: #8f87aa; font-size: .66rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    .turn .what { line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .turn.user .what { color: #cfc7f0; }
    .empty { color: #68647a; }
    #error { margin: 12px 0 0; min-height: 20px; color: #ff9dae; font-size: .85rem; }
    form { display: flex; gap: 10px; margin-top: 16px; }
    input { min-width: 0; flex: 1; border: 1px solid rgba(255,255,255,.12); border-radius: 13px; padding: 13px 15px; color: #fff; background: rgba(4,5,10,.5); font: inherit; outline: none; }
    input:focus { border-color: #8669e8; box-shadow: 0 0 0 3px rgba(134,105,232,.15); }
    .send { border-radius: 13px; padding: 0 18px; background: #7559d7; font-weight: 750; }
    .controls { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    #mic { border-radius: 13px; padding: 11px 18px; background: linear-gradient(145deg, #8d67ff, #4a2fbb); font-weight: 750; touch-action: none; user-select: none; }
    #mic.recording { background: linear-gradient(145deg, #ff657d, #c8244b); }
    #mic:disabled { opacity: .45; cursor: not-allowed; }
  </style>
</head>
<body>
  <main>
    <header>
      <div><p class="eyebrow">Private personal AI</p><h1>Talk with Shiva</h1></div>
      <div class="header-actions"><a class="secondary" href="/people">People</a><button id="newConversation" class="secondary" type="button">New conversation</button></div>
    </header>
    <div class="statusbar">
      <span id="phase" data-phase="connecting">Connecting…</span>
      <span id="connection" data-state="connecting">Connecting…</span>
    </div>
    <section id="transcript" aria-live="polite"><div class="empty">Say something or type a message to start.</div></section>
    <p id="error" role="status" aria-live="assertive"></p>
    <form id="typedForm"><input id="typedInput" maxlength="20000" autocomplete="off" placeholder="Type a message…" aria-label="Message"><button class="send" type="submit">Send</button></form>
    <div class="controls">
      <button id="mic" type="button">Hold to talk</button>
      <button id="stopSpeaking" class="secondary" type="button">Stop speaking</button>
    </div>
  </main>
  <script>${createVoiceClientScript()}</script>
</body>
</html>`;
}

export function createVoiceClientScript(): string {
  return [
    // tsx/esbuild can preserve a generated class-name helper inside
    // Function#toString during development. Define the tiny helper in the
    // standalone browser script; production tsc output simply leaves it idle.
    `const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });`,
    `const VoiceConversationState = ${VoiceConversationState.toString()};`,
    `const VoiceAudioPlayer = ${VoiceAudioPlayer.toString()};`,
    `const VoiceSocketClient = ${VoiceSocketClient.toString()};`,
    `const planAudioPlayback = ${planAudioPlayback.toString()};`,
    `const findAudibleWindow = ${findAudibleWindow.toString()};`,
    `const decodeVoiceAudioFrame = ${decodeVoiceAudioFrame.toString()};`,
  ].join("\n") + String.raw`
(() => {
  "use strict";
  const conversation = new VoiceConversationState(sessionStorage);
  const transcript = document.getElementById("transcript");
  const phaseLabel = document.getElementById("phase");
  const connectionLabel = document.getElementById("connection");
  const errorLabel = document.getElementById("error");
  const typedForm = document.getElementById("typedForm");
  const typedInput = document.getElementById("typedInput");
  const micButton = document.getElementById("mic");
  const stopButton = document.getElementById("stopSpeaking");
  const newButton = document.getElementById("newConversation");

  const PHASE_LABELS = {
    connecting: "Connecting…",
    ready: "Ready",
    listening: "Listening",
    transcribing: "Transcribing",
    thinking: "Thinking",
    speaking: "Speaking",
  };
  const CONNECTION_LABELS = {
    connecting: "Connecting…",
    open: "Connected",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
  };

  let audioContext = null;
  let player = null;
  let phase = "connecting";
  let connectionState = "connecting";
  let turn = null;
  let recorder = null;
  let mediaStream = null;
  let pressHeld = false;
  let uploadChain = Promise.resolve();

  const client = new VoiceSocketClient({
    url: socketUrl(),
    createSocket: (url) => new WebSocket(url),
    decodeAudioFrame: decodeVoiceAudioFrame,
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
    onStateChange: handleConnectionState,
    onControl: handleControlMessage,
    onAudio: handleAudioFrame,
  });

  function socketUrl() {
    const url = new URL("/voice/chat", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  function setPhase(next) {
    phase = next;
    phaseLabel.dataset.phase = next;
    phaseLabel.textContent = PHASE_LABELS[next] || next;
  }

  function setError(message) {
    errorLabel.textContent = message || "";
  }

  function handleConnectionState(state) {
    connectionState = state;
    connectionLabel.dataset.state = state;
    connectionLabel.textContent = CONNECTION_LABELS[state] || state;
    if (state === "open") {
      setError("");
      const current = conversation.current();
      client.send(current
        ? { type: "session_start", conversationId: current }
        : { type: "session_start" });
      return;
    }
    if (state !== "closed") stopPlayback();
    if (phase !== "connecting") setPhase("connecting");
  }

  function handleControlMessage(message) {
    switch (message.type) {
      case "session_ready":
        conversation.remember(message.conversationId);
        setPhase("ready");
        return;
      case "transcript_partial":
        setTranscriptText(ensureUserEntry(message.turnId), message.text);
        return;
      case "transcript_final":
        setTranscriptText(ensureUserEntry(message.turnId), message.text);
        if (phase === "listening" || phase === "transcribing") setPhase("thinking");
        return;
      case "assistant_text_delta":
        appendAssistantText(message.turnId, message.text);
        return;
      case "assistant_text_done":
        appendAssistantText(message.turnId, "");
        return;
      case "audio_start":
        startTurnPlayback(message);
        return;
      case "audio_end":
        if (turn && turn.turnId === message.turnId) {
          turn.audioEnded = true;
          reportIdleWhenFinished();
        }
        return;
      case "turn_done":
        conversation.remember(message.conversationId);
        if (message.reason === "interrupted") {
          if (turn && turn.turnId === message.turnId) stopPlayback();
          if (phase !== "listening") setPhase("ready");
          return;
        }
        if (turn && turn.turnId === message.turnId) {
          turn.done = true;
          reportIdleWhenFinished();
          return;
        }
        if (phase !== "listening") setPhase("ready");
        return;
      case "error":
        setError(message.message);
        return;
      default:
        return;
    }
  }

  function ensureAudio() {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return null;
    if (!audioContext) {
      try {
        audioContext = new AudioContextConstructor({ latencyHint: "interactive" });
      } catch {
        audioContext = null;
        return null;
      }
    }
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => {});
    if (!player) {
      player = new VoiceAudioPlayer({
        context: audioContext,
        planPlayback: planAudioPlayback,
        findAudible: findAudibleWindow,
        onEvent: handlePlayerEvent,
        unixNow: () => Date.now(),
        monotonicNow: () => performance.now(),
        setTimer: (callback, delay) => window.setTimeout(callback, delay),
        clearTimer: (timer) => window.clearTimeout(timer),
      });
    }
    return player;
  }

  function startTurnPlayback(message) {
    const active = ensureAudio();
    if (!active) {
      setError("This browser cannot play Shiva's voice.");
      return;
    }
    if (!turn || turn.turnId !== message.turnId) {
      turn = createTurnState(message.turnId);
    }
    turn.turnSequence = message.turnSequence;
    turn.audioStarted = true;
    active.beginTurn(message.turnSequence);
  }

  function handleAudioFrame(frame) {
    const active = player;
    if (!active || !turn || frame.header.turnSequence !== turn.turnSequence) return;
    const receivedAt = Date.now();
    reportPlayback({
      event: "received",
      chunkId: frame.header.chunkId,
      timestampMs: receivedAt,
    });
    console.debug("[SHIVA VOICE AUDIO]", {
      turnId: turn.turnId,
      chunkId: frame.header.chunkId,
      format: frame.header.format,
      bytes: frame.audio.byteLength,
      audioDurationMs: frame.header.audioDurationMs,
      receivedAt,
    });
    active.enqueue({
      turnSequence: frame.header.turnSequence,
      chunkId: frame.header.chunkId,
      format: frame.header.format,
      sampleRate: frame.header.sampleRate,
      channels: frame.header.channels,
      audio: frame.audio,
    });
  }

  function handlePlayerEvent(event) {
    if (!turn || event.turnSequence !== turn.turnSequence) return;
    if (event.type === "drained") {
      reportIdleWhenFinished();
      return;
    }
    if (event.type === "error") {
      setError(event.message);
      return;
    }
    if (event.type === "started") setPhase("speaking");
    if (event.type === "underrun") {
      console.warn("[SHIVA VOICE UNDERRUN]", {
        turnId: turn.turnId,
        chunkId: event.chunkId,
        underrunMs: Math.round(event.underrunMs),
      });
    }
    if (event.type === "scheduled") {
      console.debug("[SHIVA VOICE PLAYBACK]", {
        turnId: turn.turnId,
        chunkId: event.chunkId,
        decodeDurationMs: Math.round(event.decodeDurationMs * 100) / 100,
        startAtSeconds: event.startAtSeconds,
        underrunMs: Math.round(event.underrunMs),
      });
    }
    reportPlayback({
      event: event.type,
      chunkId: event.chunkId,
      timestampMs: event.timestampMs,
      decodeDurationMs: event.type === "scheduled" ? event.decodeDurationMs : undefined,
      underrunMs: event.type === "underrun" ? event.underrunMs : undefined,
    });
  }

  function reportPlayback(detail) {
    if (!turn) return;
    const payload = {
      type: "playback",
      turnId: turn.turnId,
      event: detail.event,
      chunkId: detail.chunkId,
      timestampMs: detail.timestampMs,
    };
    if (detail.decodeDurationMs !== undefined) {
      payload.decodeDurationMs = Math.round(detail.decodeDurationMs * 100) / 100;
    }
    if (detail.underrunMs !== undefined) {
      payload.underrunMs = Math.round(detail.underrunMs * 100) / 100;
    }
    client.send(payload);
  }

  function reportIdleWhenFinished() {
    if (!turn || turn.idleSent || !turn.done) return;
    if (turn.audioStarted && (!turn.audioEnded || (player && !player.isIdle()))) return;
    turn.idleSent = true;
    client.send({ type: "playback", turnId: turn.turnId, event: "idle", timestampMs: Date.now() });
    if (phase !== "listening") setPhase("ready");
  }

  function createTurnState(turnId) {
    return {
      turnId,
      turnSequence: -1,
      userEntry: null,
      assistantEntry: null,
      assistantText: "",
      audioStarted: false,
      audioEnded: false,
      done: false,
      idleSent: false,
    };
  }

  function beginLocalTurn() {
    stopPlayback();
    turn = null;
    setError("");
  }

  function stopPlayback() {
    if (player) player.stop();
  }

  function clearPlaceholder() {
    const placeholder = transcript.querySelector(".empty");
    if (placeholder) placeholder.remove();
  }

  function addEntry(role, text) {
    clearPlaceholder();
    const entry = document.createElement("div");
    entry.className = "turn " + role;
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "user" ? "You" : "Shiva";
    const what = document.createElement("div");
    what.className = "what";
    what.textContent = text;
    entry.appendChild(who);
    entry.appendChild(what);
    transcript.appendChild(entry);
    transcript.scrollTop = transcript.scrollHeight;
    return what;
  }

  function setTranscriptText(element, text) {
    if (!element) return;
    element.textContent = text;
    transcript.scrollTop = transcript.scrollHeight;
  }

  function ensureUserEntry(turnId) {
    if (!turn || turn.turnId !== turnId) {
      turn = createTurnState(turnId);
    }
    if (!turn.userEntry) turn.userEntry = addEntry("user", "");
    return turn.userEntry;
  }

  function appendAssistantText(turnId, text) {
    if (!turn || turn.turnId !== turnId) {
      turn = createTurnState(turnId);
    }
    if (!turn.assistantEntry) turn.assistantEntry = addEntry("assistant", "");
    turn.assistantText += text;
    setTranscriptText(turn.assistantEntry, turn.assistantText);
    if (phase === "thinking" || phase === "transcribing") setPhase("thinking");
  }

  function sendTypedMessage(text) {
    if (!text) return;
    if (connectionState !== "open") {
      setError("Shiva's voice connection is not available yet.");
      return;
    }
    ensureAudio();
    beginLocalTurn();
    addEntry("user", text);
    client.send({ type: "user_text", text: text });
    setPhase("thinking");
  }

  function selectedMimeType() {
    const choices = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const choice of choices) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(choice)) return choice;
    }
    return "";
  }

  async function startRecording() {
    if (recorder) return;
    if (connectionState !== "open") {
      setError("Shiva's voice connection is not available yet.");
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setError("This browser cannot record audio. Use the text input instead.");
      return;
    }

    ensureAudio();
    beginLocalTurn();
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Microphone access failed.");
      return;
    }

    const mimeType = selectedMimeType();
    recorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType: mimeType })
      : new MediaRecorder(mediaStream);
    uploadChain = Promise.resolve();
    client.send({ type: "audio_start", mimeType: recorder.mimeType || mimeType || "audio/webm" });
    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size === 0) return;
      uploadChain = uploadChain.then(async () => {
        const buffer = await event.data.arrayBuffer();
        client.sendAudio(new Uint8Array(buffer));
      });
    });
    recorder.addEventListener("stop", () => {
      recorder = null;
      releaseMicrophone();
      uploadChain.then(() => {
        client.send({ type: "audio_end" });
        setPhase("transcribing");
      }).catch(() => {
        setError("The recording could not be sent.");
      });
    });
    recorder.start(200);
    micButton.classList.add("recording");
    setPhase("listening");
    if (!pressHeld) stopRecording();
  }

  function stopRecording() {
    micButton.classList.remove("recording");
    if (recorder) {
      recorder.stop();
      return;
    }
    releaseMicrophone();
  }

  function releaseMicrophone() {
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  typedForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = typedInput.value.trim();
    typedInput.value = "";
    sendTypedMessage(text);
  });
  micButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    pressHeld = true;
    if (micButton.setPointerCapture) micButton.setPointerCapture(event.pointerId);
    void startRecording();
  });
  micButton.addEventListener("pointerup", () => { pressHeld = false; stopRecording(); });
  micButton.addEventListener("pointercancel", () => { pressHeld = false; stopRecording(); });
  stopButton.addEventListener("click", () => {
    stopPlayback();
    client.send({ type: "interrupt" });
    if (phase !== "listening") setPhase("ready");
  });
  newButton.addEventListener("click", () => {
    stopPlayback();
    client.send({ type: "interrupt" });
    conversation.clear();
    client.send({ type: "session_start" });
    turn = null;
    transcript.textContent = "";
    const placeholder = document.createElement("div");
    placeholder.className = "empty";
    placeholder.textContent = "Say something or type a message to start.";
    transcript.appendChild(placeholder);
    setError("");
  });
  window.addEventListener("pagehide", () => {
    stopPlayback();
    client.close();
  });

  client.connect();
})();`;
}
