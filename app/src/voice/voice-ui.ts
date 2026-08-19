import { VoiceConversationState } from "./conversation-state.js";

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
  return `const VoiceConversationState = ${VoiceConversationState.toString()};\n` + String.raw`
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
  let speechGeneration = 0;
  let ttsSequence = 0;
  let synthesisChain = Promise.resolve();
  let audioQueue = [];
  let playing = false;
  let currentAudioUrl = null;
  const synthesisControllers = new Set();

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

  async function startRecording() {
    if (recorder && recorder.state === "recording") return;
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
    const generation = speechGeneration;
    ttsSequence = 0;
    synthesisChain = Promise.resolve();
    setCopy(transcription, message);
    setCopy(responseText, "");
    setStatus("Shiva is thinking…");
    let sentenceBuffer = "";

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
        sentenceBuffer += text;
        setCopy(responseText, fullResponse);
        sentenceBuffer = queueCompleteSentences(sentenceBuffer, turnId, generation);
        setStatus("Shiva is replying…");
      }
      const tail = decoder.decode();
      fullResponse += tail;
      sentenceBuffer += tail;
      setCopy(responseText, fullResponse);
      if (sentenceBuffer.trim()) queueSpeech(sentenceBuffer.trim(), turnId, generation);
      setStatus("Ready");
    } finally {
      reader.releaseLock();
    }
  }

  function queueCompleteSentences(buffer, turnId, generation) {
    let remaining = buffer;
    while (true) {
      const match = remaining.match(/^([\s\S]*?[.!?]+)(?=\s|$)/);
      if (!match) return remaining;
      const sentence = match[1].trim();
      remaining = remaining.slice(match[1].length).trimStart();
      if (sentence) queueSpeech(sentence, turnId, generation);
    }
  }

  function queueSpeech(text, turnId, generation) {
    const sequence = ttsSequence++;
    synthesisChain = synthesisChain.then(async () => {
      if (generation !== speechGeneration) return;
      const controller = new AbortController();
      synthesisControllers.add(controller);
      try {
        const result = await fetch("/voice/synthesize", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shiva-voice-turn-id": turnId,
            "x-shiva-voice-sequence": String(sequence),
          },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (!result.ok) throw new Error(await publicError(result));
        const blob = await result.blob();
        if (generation !== speechGeneration) return;
        audioQueue.push({ url: URL.createObjectURL(blob), generation });
        void playAudioQueue();
      } catch (error) {
        if (generation === speechGeneration && !(error instanceof DOMException && error.name === "AbortError")) {
          setStatus(error instanceof Error ? error.message : "Speech synthesis failed.", true);
        }
      } finally {
        synthesisControllers.delete(controller);
      }
    });
  }

  async function playAudioQueue() {
    if (playing) return;
    playing = true;
    try {
      while (audioQueue.length > 0) {
        const item = audioQueue.shift();
        if (item.generation !== speechGeneration) {
          URL.revokeObjectURL(item.url);
          continue;
        }
        audio.src = item.url;
        currentAudioUrl = item.url;
        let played = false;
        try {
          await audio.play();
          played = true;
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
        } catch {
          if (item.generation === speechGeneration) {
            setStatus("Audio is ready. Press play to hear Shiva.");
          }
          return;
        } finally {
          if (played || item.generation !== speechGeneration) {
            URL.revokeObjectURL(item.url);
            if (currentAudioUrl === item.url) currentAudioUrl = null;
          }
        }
      }
    } finally {
      playing = false;
    }
  }

  function stopSpeaking() {
    speechGeneration += 1;
    synthesisControllers.forEach((controller) => controller.abort());
    synthesisControllers.clear();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
    audioQueue.forEach((item) => URL.revokeObjectURL(item.url));
    audioQueue = [];
    playing = false;
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
    void startRecording();
  });
  mic.addEventListener("pointerup", () => { pressHeld = false; stopRecording(); });
  mic.addEventListener("pointercancel", () => { pressHeld = false; stopRecording(); });
  typedForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = typedInput.value.trim();
    if (!message) return;
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
})();`;
}
