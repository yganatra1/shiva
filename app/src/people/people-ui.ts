export function createPeoplePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>People · Shiva</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #090a10; color: #f5f2ff; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; background: radial-gradient(circle at 15% 0%, #2b1c58 0, transparent 34rem), radial-gradient(circle at 95% 15%, #123e46 0, transparent 30rem), #090a10; }
    button, input, textarea { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    .shell { width: min(1160px, 100%); margin: 0 auto; padding: clamp(18px, 4vw, 42px); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 5px; font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -.055em; }
    h2 { letter-spacing: -.025em; }
    .eyebrow { margin-bottom: 6px; color: #b69cff; font-size: .72rem; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
    .muted { color: #aaa4bc; line-height: 1.55; }
    .nav { display: flex; gap: 9px; flex-wrap: wrap; }
    .nav a, .secondary { border: 1px solid rgba(255,255,255,.13); border-radius: 12px; padding: 10px 14px; color: #eee9ff; background: rgba(255,255,255,.055); text-decoration: none; }
    .nav a:hover, .secondary:hover { background: rgba(255,255,255,.1); }
    .nav a.locked { opacity: .45; pointer-events: none; }
    .layout { display: grid; grid-template-columns: minmax(270px, .8fr) minmax(0, 1.4fr); gap: 20px; align-items: start; }
    .panel { border: 1px solid rgba(255,255,255,.1); border-radius: 24px; background: rgba(17,18,29,.84); box-shadow: 0 24px 70px rgba(0,0,0,.28); backdrop-filter: blur(18px); }
    .panel-inner { padding: clamp(18px, 3vw, 28px); }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .section-head h2 { margin-bottom: 0; }
    .person-list { display: grid; gap: 10px; margin-top: 18px; }
    .person-card { width: 100%; border: 1px solid rgba(255,255,255,.09); border-radius: 16px; padding: 14px; color: inherit; background: rgba(255,255,255,.035); text-align: left; cursor: pointer; }
    .person-card:hover, .person-card.active { border-color: rgba(155,127,255,.7); background: rgba(135,95,255,.1); }
    .person-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .person-name { font-weight: 800; }
    .person-meta { margin-top: 5px; color: #aaa4bc; font-size: .82rem; }
    .badge { border-radius: 999px; padding: 4px 8px; background: rgba(255,255,255,.08); color: #cbc4df; font-size: .68rem; font-weight: 800; }
    .badge.ready { background: rgba(53,211,153,.15); color: #74e5b8; }
    .empty { padding: 22px 14px; border: 1px dashed rgba(255,255,255,.12); border-radius: 15px; color: #858096; text-align: center; }
    form { display: grid; gap: 16px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    label { display: grid; gap: 7px; color: #d9d4e8; font-size: .83rem; font-weight: 700; }
    input[type="text"], textarea { width: 100%; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 12px 13px; color: #fff; background: rgba(4,5,10,.52); outline: none; resize: vertical; }
    input[type="text"]:focus, textarea:focus { border-color: #8b6cf0; box-shadow: 0 0 0 3px rgba(139,108,240,.15); }
    textarea { min-height: 86px; }
    .check { display: flex; align-items: center; gap: 9px; }
    .check input { width: 18px; height: 18px; accent-color: #8768ed; }
    .drop { display: grid; place-items: center; min-height: 142px; border: 1px dashed rgba(176,153,255,.46); border-radius: 17px; padding: 18px; background: rgba(128,91,255,.055); text-align: center; cursor: pointer; }
    .drop:hover, .drop.drag { background: rgba(128,91,255,.11); }
    .drop.locked { opacity: .5; cursor: not-allowed; }
    .drop input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .drop strong { display: block; margin-bottom: 5px; }
    .privacy { border-radius: 14px; padding: 12px 14px; color: #a9c8c3; background: rgba(36,141,123,.095); font-size: .8rem; line-height: 1.5; }
    .queue { display: grid; gap: 8px; }
    .queue-head { display: flex; justify-content: space-between; gap: 10px; font-size: .8rem; color: #aaa4bc; }
    .photo { display: grid; grid-template-columns: 48px minmax(0,1fr) auto; align-items: center; gap: 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 8px; background: rgba(255,255,255,.025); }
    .photo img { width: 48px; height: 48px; border-radius: 9px; object-fit: cover; background: #05060a; }
    .photo-name { overflow: hidden; font-size: .8rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .photo-status { margin-top: 3px; color: #9993aa; font-size: .72rem; line-height: 1.25; }
    .photo-status.accepted { color: #66dcae; }
    .photo-status.rejected { color: #ff9cad; }
    .photo-actions { display: flex; align-items: center; gap: 6px; }
    .remove, .mini { min-width: 42px; min-height: 42px; border: 0; border-radius: 9px; color: #b9b2c9; background: rgba(255,255,255,.06); cursor: pointer; }
    .mini { padding: 7px 10px; font-size: .72rem; font-weight: 800; }
    .mini.danger { color: #ffafbc; background: rgba(255,90,119,.1); }
    .photo-placeholder { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 9px; color: #817a92; background: #05060a; font-size: .68rem; font-weight: 800; }
    .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .primary { border: 0; border-radius: 13px; padding: 12px 18px; color: #fff; background: linear-gradient(145deg,#8e6cff,#5e3cc8); font-weight: 800; cursor: pointer; }
    .primary:hover { filter: brightness(1.08); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    #message { min-height: 21px; color: #aaa4bc; font-size: .84rem; }
    #message.error { color: #ff9cad; }
    #message.success { color: #66dcae; }
    .progress { height: 7px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.08); }
    .progress span { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg,#8e6cff,#50d4aa); transition: width .2s ease; }
    .samples { display: grid; gap: 8px; padding-top: 2px; }
    .samples-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .samples-head h3 { margin: 0; font-size: 1rem; }
    .sample { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 10px 12px; background: rgba(255,255,255,.025); }
    .sample strong { display: block; font-size: .8rem; }
    .sample span { color: #9993aa; font-size: .72rem; line-height: 1.35; }
    .tester { margin-top: 20px; }
    .tester-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .tester input { max-width: 100%; }
    #identifyResult { margin-top: 12px; min-height: 24px; color: #c8c1da; line-height: 1.5; }
    @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .grid-2 { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div><p class="eyebrow">Private identity memory</p><h1>People Shiva knows</h1><p class="muted">Teach Shiva who matters to you, then recognize them locally in photos.</p></div>
      <nav class="nav"><a href="/voice">Talk with Shiva</a><a href="/health">Health</a></nav>
    </header>
    <div class="layout">
      <aside class="panel"><div class="panel-inner">
        <div class="section-head"><h2>People</h2><button id="newPerson" class="secondary" type="button">New</button></div>
        <div id="personList" class="person-list"><div class="empty">Loading people…</div></div>
      </div></aside>
      <main>
        <section class="panel"><div class="panel-inner">
          <div class="section-head"><div><p class="eyebrow">Profile + face gallery</p><h2 id="formTitle">Add a person</h2></div></div>
          <form id="personForm">
            <div class="grid-2">
              <label>Display name<input id="displayName" type="text" maxlength="255" required autocomplete="name" placeholder="Yash"></label>
              <label>Relationship<input id="relationship" type="text" maxlength="500" placeholder="Friend, wife, colleague…"></label>
            </div>
            <label class="check"><input id="isOwner" type="checkbox"> This is me, Shiva's owner</label>
            <label>Aliases<textarea id="aliases" maxlength="4000" placeholder="One per line, e.g. Chimu"></textarea></label>
            <label>Useful details<textarea id="details" maxlength="12000" placeholder="One key: value per line&#10;birthday: 12 March&#10;favourite coffee: flat white"></textarea></label>
            <label>Notes<textarea id="notes" maxlength="10000" placeholder="Anything Shiva should know about this person"></textarea></label>
            <label class="drop" id="dropZone"><input id="photos" type="file" accept="image/*" multiple><span><strong>Select 10–15 or more varied photos</strong>Different lighting, angles, expressions, and days improve recognition. One visible face per enrollment photo.</span></label>
            <div class="privacy">Originals stay in this browser. Resized copies are processed by your private Shiva face service and discarded after analysis; no original or resized image file is retained. PostgreSQL keeps the 512-dimensional face template, detection and quality metadata, and a duplicate-prevention hash.</div>
            <div id="queueWrap" class="queue" hidden><div class="queue-head"><span id="queueCount"></span><span id="queueSummary"></span></div><div class="progress"><span id="progressBar"></span></div><div id="photoQueue" class="queue"></div></div>
            <section id="samplesWrap" class="samples" hidden><div class="samples-head"><h3>Enrolled face samples</h3><span id="sampleCount" class="muted"></span></div><div id="faceSamples" class="samples"></div></section>
            <div class="actions"><button id="save" class="primary" type="submit">Save and enroll queued photos</button><button id="clearPhotos" class="secondary" type="button">Clear local queue</button></div>
            <div id="message" role="status" aria-live="polite"></div>
          </form>
        </div></section>
        <section class="panel tester"><div class="panel-inner"><p class="eyebrow">Recognition check</p><h2>Test a photo</h2><p class="muted">Upload a photo with one or more faces. Shiva will identify enrolled people and leave uncertain faces unknown.</p><div class="tester-row"><input id="identifyPhoto" type="file" accept="image/*" capture="environment"><button id="identify" class="secondary" type="button">Identify people</button></div><div id="identifyResult" role="status" aria-live="polite"></div></div></section>
      </main>
    </div>
  </div>
  <script>${createPeopleClientScript()}</script>
</body>
</html>`;
}

export function createPeopleClientScript(): string {
  return String.raw`(() => {
  "use strict";
  const state = {
    people: [],
    activeId: null,
    files: [],
    faceSamples: [],
    busy: false,
    dirty: false,
    savedSignature: null,
  };
  const byId = (id) => document.getElementById(id);
  const personList = byId("personList");
  const form = byId("personForm");
  const photos = byId("photos");
  const dropZone = byId("dropZone");
  const queueWrap = byId("queueWrap");
  const photoQueue = byId("photoQueue");
  const samplesWrap = byId("samplesWrap");
  const faceSamples = byId("faceSamples");
  const message = byId("message");
  const navLinks = Array.from(document.querySelectorAll(".nav a"));
  const profileFields = ["displayName", "relationship", "isOwner", "aliases", "details", "notes"].map(byId);
  state.savedSignature = formSignature();

  function setMessage(text, kind) {
    message.textContent = text || "";
    message.className = kind || "";
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    if (response.status === 204) return null;
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error((body && body.error && body.error.message) || "Shiva could not complete this request.");
      error.code = body && body.error && body.error.code;
      throw error;
    }
    return body;
  }

  async function loadPeople(selectId, preserveFiles) {
    const body = await api("/api/people", { headers: { accept: "application/json" } });
    state.people = body.people || [];
    renderPeople();
    if (selectId) await selectPerson(selectId, Boolean(preserveFiles), true);
  }

  function renderPeople() {
    personList.textContent = "";
    if (!state.people.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No one enrolled yet. Start with yourself.";
      personList.appendChild(empty);
      return;
    }
    state.people.forEach((person) => {
      const card = document.createElement("button");
      card.type = "button";
      card.disabled = state.busy;
      card.className = "person-card" + (person.id === state.activeId ? " active" : "");
      const top = document.createElement("div");
      top.className = "person-top";
      const name = document.createElement("span");
      name.className = "person-name";
      name.textContent = person.displayName + (person.isOwner ? " (you)" : "");
      const badge = document.createElement("span");
      badge.className = "badge" + (person.faceReady ? " ready" : "");
      badge.textContent = person.faceReady ? "READY" : String(person.faceSampleCount) + "/5";
      top.append(name, badge);
      const meta = document.createElement("div");
      meta.className = "person-meta";
      meta.textContent = (person.relationship || "Known person") + " · " + person.faceSampleCount + " face sample" + (person.faceSampleCount === 1 ? "" : "s");
      card.append(top, meta);
      card.addEventListener("click", () => navigateToPerson(person.id));
      personList.appendChild(card);
    });
  }

  function hasNavigationRisk() {
    return state.dirty || state.files.some((entry) =>
      entry.status === "waiting" ||
      entry.status === "preparing" ||
      entry.status === "uploading" ||
      (entry.status === "rejected" && entry.retryable)
    );
  }

  function confirmNavigation() {
    if (!hasNavigationRisk()) return true;
    return window.confirm("Discard unsaved profile changes and queued photos?");
  }

  async function navigateToPerson(id) {
    if (state.busy || id === state.activeId || !confirmNavigation()) return;
    await selectPerson(id, false, true);
  }

  async function selectPerson(id, preserveFiles, bypassWarning) {
    if (state.busy && !bypassWarning) return;
    const person = state.people.find((entry) => entry.id === id);
    if (!person) return;
    state.activeId = id;
    byId("formTitle").textContent = "Edit " + person.displayName;
    byId("displayName").value = person.displayName || "";
    byId("relationship").value = person.relationship || "";
    byId("isOwner").checked = Boolean(person.isOwner);
    byId("aliases").value = (person.aliases || []).join("\n");
    byId("details").value = Object.entries(person.details || {}).map((entry) => entry[0] + ": " + entry[1]).join("\n");
    byId("notes").value = person.notes || "";
    if (!preserveFiles) clearFiles();
    state.savedSignature = formSignature();
    state.dirty = false;
    state.faceSamples = [];
    renderSamples(true);
    setMessage("Add more photos at any time; existing templates stay enrolled.", "");
    renderPeople();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const body = await api("/api/people/" + encodeURIComponent(id), { headers: { accept: "application/json" } });
      if (state.activeId !== id) return;
      state.faceSamples = body.faceSamples || [];
      if (body.person) upsertPerson(body.person);
      renderSamples(false);
      renderPeople();
    } catch (error) {
      if (state.activeId !== id) return;
      renderSamples(false);
      setMessage(error.message || "The profile loaded, but its face samples could not be listed.", "error");
    }
  }

  function resetForm() {
    state.activeId = null;
    form.reset();
    byId("formTitle").textContent = "Add a person";
    clearFiles();
    state.faceSamples = [];
    state.savedSignature = formSignature();
    state.dirty = false;
    renderSamples(false);
    setMessage("", "");
    renderPeople();
  }

  function beginNewPerson() {
    if (state.busy || !confirmNavigation()) return;
    resetForm();
  }

  function parseLines(value) {
    return [...new Set(value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean))];
  }

  function formSignature() {
    return JSON.stringify(profileFields.map((field) =>
      field.type === "checkbox" ? field.checked : field.value
    ));
  }

  function parseDetails(value) {
    const output = {};
    const seen = new Set();
    value.split(/\r?\n/).forEach((line, lineIndex) => {
      if (!line.trim()) return;
      const index = line.indexOf(":");
      if (index < 1) {
        throw new Error("Details line " + (lineIndex + 1) + " must use key: value.");
      }
      const key = line.slice(0, index).trim();
      const detail = line.slice(index + 1).trim();
      if (!key || !detail) {
        throw new Error("Details line " + (lineIndex + 1) + " must have text on both sides of the colon.");
      }
      if (key.length > 128) {
        throw new Error("Details line " + (lineIndex + 1) + " has a key longer than 128 characters.");
      }
      if (detail.length > 4000) {
        throw new Error("Details line " + (lineIndex + 1) + " has a value longer than 4,000 characters.");
      }
      const normalizedKey = key.toLocaleLowerCase();
      if (seen.has(normalizedKey)) {
        throw new Error("Details line " + (lineIndex + 1) + " repeats the key ‘" + key + "’.");
      }
      seen.add(normalizedKey);
      output[key] = detail;
    });
    return output;
  }

  function personPayload() {
    const relationship = byId("relationship").value.trim();
    const notes = byId("notes").value.trim();
    return {
      displayName: byId("displayName").value.trim(),
      isOwner: byId("isOwner").checked,
      relationship: relationship || null,
      aliases: parseLines(byId("aliases").value),
      details: parseDetails(byId("details").value),
      notes: notes || null,
    };
  }

  function addFiles(fileList) {
    if (state.busy) return;
    const selected = Array.from(fileList || []);
    const known = new Set(state.files.map((entry) => entry.file.name + ":" + entry.file.size + ":" + entry.file.lastModified));
    selected.forEach((file) => {
      const key = file.name + ":" + file.size + ":" + file.lastModified;
      if (!known.has(key)) {
        known.add(key);
        const supported = isSupportedImageFile(file);
        state.files.push({
          file: file,
          url: supported ? URL.createObjectURL(file) : null,
          status: supported ? "waiting" : "rejected",
          detail: supported ? "Waiting to upload" : "Unsupported file type. Choose a JPEG, PNG, WebP, HEIF, or another browser-readable image.",
          retryable: supported,
          faceSampleId: null,
        });
      }
    });
    renderQueue();
  }

  function isSupportedImageFile(file) {
    if (file.type && file.type.startsWith("image/")) return true;
    return /\.(?:jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.name);
  }

  function clearFiles() {
    if (state.busy) return;
    state.files.forEach((entry) => { if (entry.url) URL.revokeObjectURL(entry.url); });
    state.files = [];
    photos.value = "";
    renderQueue();
  }

  function renderQueue() {
    queueWrap.hidden = state.files.length === 0;
    photoQueue.textContent = "";
    let accepted = 0;
    let rejected = 0;
    let completed = 0;
    state.files.forEach((entry, index) => {
      if (entry.status === "accepted") accepted += 1;
      if (entry.status === "rejected") rejected += 1;
      if (["accepted", "rejected"].includes(entry.status)) completed += 1;
      const row = document.createElement("div");
      row.className = "photo";
      const image = entry.url ? document.createElement("img") : document.createElement("div");
      if (entry.url) {
        image.src = entry.url;
        image.alt = "";
      } else {
        image.className = "photo-placeholder";
        image.textContent = "FILE";
      }
      const text = document.createElement("div");
      const name = document.createElement("div");
      name.className = "photo-name";
      name.textContent = entry.file.name;
      const status = document.createElement("div");
      status.className = "photo-status " + entry.status;
      status.textContent = entry.detail;
      text.append(name, status);
      const actions = document.createElement("div");
      actions.className = "photo-actions";
      if (entry.status === "rejected" && entry.retryable) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "mini";
        retry.textContent = "Retry";
        retry.disabled = state.busy;
        retry.addEventListener("click", () => retryEntry(entry));
        actions.appendChild(retry);
      }
      if (entry.status === "accepted" && entry.faceSampleId) {
        const deleteSample = document.createElement("button");
        deleteSample.type = "button";
        deleteSample.className = "mini danger";
        deleteSample.textContent = "Delete";
        deleteSample.disabled = state.busy;
        deleteSample.setAttribute("aria-label", "Delete the enrolled sample from " + entry.file.name);
        deleteSample.addEventListener("click", () => deleteFaceSample(entry.faceSampleId, entry));
        actions.appendChild(deleteSample);
      } else if (entry.status !== "accepted" && entry.status !== "uploading" && entry.status !== "preparing") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove";
        remove.textContent = "×";
        remove.disabled = state.busy;
        remove.setAttribute("aria-label", "Remove " + entry.file.name + " from the local queue");
        remove.addEventListener("click", () => removeQueueEntry(index));
        actions.appendChild(remove);
      }
      row.append(image, text, actions);
      photoQueue.appendChild(row);
    });
    byId("queueCount").textContent = state.files.length + " selected";
    byId("queueSummary").textContent = accepted + " accepted · " + rejected + " rejected";
    byId("progressBar").style.width = (state.files.length ? completed / state.files.length * 100 : 0) + "%";
    byId("clearPhotos").disabled = state.busy || state.files.length === 0;
  }

  function removeQueueEntry(index) {
    if (state.busy) return;
    const entry = state.files[index];
    if (!entry || entry.status === "accepted") return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    state.files.splice(index, 1);
    renderQueue();
  }

  function retryEntry(entry) {
    if (state.busy || entry.status !== "rejected" || !entry.retryable) return;
    entry.status = "waiting";
    entry.detail = "Queued to retry when you press Save";
    renderQueue();
  }

  function upsertPerson(person) {
    const index = state.people.findIndex((entry) => entry.id === person.id);
    if (index < 0) state.people.push(person);
    else state.people[index] = person;
  }

  function renderSamples(loading) {
    samplesWrap.hidden = !state.activeId;
    faceSamples.textContent = "";
    if (!state.activeId) return;
    byId("sampleCount").textContent = loading ? "Loading…" : state.faceSamples.length + " stored";
    if (loading) return;
    if (!state.faceSamples.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No accepted face samples yet.";
      faceSamples.appendChild(empty);
      return;
    }
    state.faceSamples.forEach((sample, index) => {
      const row = document.createElement("div");
      row.className = "sample";
      const text = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "Face sample " + (index + 1);
      const metadata = document.createElement("span");
      const quality = typeof sample.qualityScore === "number" ? "Quality " + Math.round(sample.qualityScore * 100) + "%" : "Quality unavailable";
      const date = sample.createdAt ? new Date(sample.createdAt).toLocaleDateString() : "date unavailable";
      metadata.textContent = quality + " · added " + date;
      text.append(title, metadata);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "mini danger";
      remove.textContent = "Delete";
      remove.disabled = state.busy;
      remove.setAttribute("aria-label", "Delete face sample " + (index + 1));
      remove.addEventListener("click", () => deleteFaceSample(sample.id));
      row.append(text, remove);
      faceSamples.appendChild(row);
    });
  }

  async function resizeImage(file) {
    const decoded = await decodeImage(file);
    try {
      const scale = Math.min(1, 1600 / Math.max(decoded.width, decoded.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw nonRetryableImageError("This browser could not prepare the image canvas.");
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(nonRetryableImageError("This browser could not convert the image to JPEG.")),
        "image/jpeg",
        .88,
      ));
    } finally {
      decoded.dispose();
    }
  }

  async function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return bitmapSource(bitmap);
      } catch (_) {
        try {
          const bitmap = await createImageBitmap(file);
          return bitmapSource(bitmap);
        } catch (_) {}
      }
    }
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        dispose: () => URL.revokeObjectURL(url),
      });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(nonRetryableImageError("This browser cannot read " + file.name + ". Convert it to JPEG, PNG, or WebP and try again."));
      };
      image.src = url;
    });
  }

  function bitmapSource(bitmap) {
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    };
  }

  function nonRetryableImageError(messageText) {
    const error = new Error(messageText);
    error.retryable = false;
    return error;
  }

  async function uploadEntry(entry, personId) {
    entry.status = "preparing";
    entry.detail = "Preparing a private resized copy…";
    renderQueue();
    try {
      const blob = await resizeImage(entry.file);
      entry.status = "uploading";
      entry.detail = "Checking face quality…";
      renderQueue();
      const body = await api("/api/people/" + encodeURIComponent(personId) + "/faces", {
        method: "POST",
        headers: { "content-type": "image/jpeg", accept: "application/json" },
        body: blob,
      });
      entry.status = "accepted";
      entry.retryable = false;
      entry.faceSampleId = body.faceSample && body.faceSample.id;
      const quality = body.faceSample && typeof body.faceSample.qualityScore === "number"
        ? " · quality " + Math.round(body.faceSample.qualityScore * 100) + "%"
        : "";
      entry.detail = "Accepted into the face gallery" + quality;
      if (body.person) upsertPerson(body.person);
      if (body.faceSample && !state.faceSamples.some((sample) => sample.id === body.faceSample.id)) {
        state.faceSamples.push(body.faceSample);
      }
    } catch (error) {
      entry.status = "rejected";
      entry.detail = error.message || "Rejected";
      const permanentCodes = new Set([
        "INVALID_IMAGE",
        "PAYLOAD_TOO_LARGE",
        "UNSUPPORTED_MEDIA_TYPE",
        "NO_FACE",
        "MULTIPLE_FACES",
        "LOW_QUALITY",
        "FACE_MISMATCH",
        "DUPLICATE_FACE",
      ]);
      entry.retryable =
        error.retryable !== false && !permanentCodes.has(error.code);
    }
    renderQueue();
    renderSamples(false);
  }

  async function uploadAll(personId) {
    const pending = state.files.filter((entry) => entry.status === "waiting");
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        const entry = pending[cursor++];
        if (entry) await uploadEntry(entry, personId);
      }
    }
    await Promise.all([worker(), worker()]);
  }

  async function deleteFaceSample(faceId, queueEntry) {
    if (state.busy || !state.activeId || !faceId) return;
    if (!window.confirm("Permanently delete this face sample from Shiva?")) return;
    setBusy(true);
    setMessage("Deleting the enrolled face sample…", "");
    try {
      await api("/api/people/" + encodeURIComponent(state.activeId) + "/faces/" + encodeURIComponent(faceId), { method: "DELETE" });
      state.faceSamples = state.faceSamples.filter((sample) => sample.id !== faceId);
      state.files
        .filter((entry) => entry === queueEntry || entry.faceSampleId === faceId)
        .forEach((entry) => { if (entry.url) URL.revokeObjectURL(entry.url); });
      state.files = state.files.filter((entry) => entry !== queueEntry && entry.faceSampleId !== faceId);
      const activeId = state.activeId;
      try {
        await loadPeople(activeId, true);
        setMessage("Face sample deleted. Other enrolled samples are unchanged.", "success");
      } catch (_) {
        renderQueue();
        renderSamples(false);
        setMessage("Face sample deleted, but the refreshed sample count could not be loaded.", "");
      }
    } catch (error) {
      setMessage(error.message || "The face sample could not be deleted.", "error");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    byId("save").disabled = busy;
    byId("newPerson").disabled = busy;
    byId("clearPhotos").disabled = busy || state.files.length === 0;
    photos.disabled = busy;
    byId("identifyPhoto").disabled = busy;
    byId("identify").disabled = busy;
    dropZone.classList.toggle("locked", busy);
    navLinks.forEach((link) => {
      link.classList.toggle("locked", busy);
      link.setAttribute("aria-disabled", busy ? "true" : "false");
      link.tabIndex = busy ? -1 : 0;
    });
    profileFields.forEach((field) => { field.disabled = busy; });
    renderPeople();
    renderQueue();
    renderSamples(false);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    let payload;
    try {
      payload = personPayload();
    } catch (error) {
      setMessage(error.message || "Check the profile details and try again.", "error");
      byId("details").focus();
      return;
    }
    if (!payload.displayName) return setMessage("Enter a display name first.", "error");
    setBusy(true);
    setMessage(state.activeId ? "Saving changes…" : "Creating person…", "");
    try {
      const url = state.activeId ? "/api/people/" + encodeURIComponent(state.activeId) : "/api/people";
      const body = await api(url, { method: state.activeId ? "PATCH" : "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
      state.activeId = body.person.id;
      state.savedSignature = formSignature();
      state.dirty = false;
      upsertPerson(body.person);
      const pendingCount = state.files.filter((entry) => entry.status === "waiting").length;
      if (pendingCount) {
        setMessage("Profile saved. Processing " + pendingCount + " queued photo" + (pendingCount === 1 ? "" : "s") + " privately…", "");
        await uploadAll(state.activeId);
      }
      let refreshed = true;
      try {
        await loadPeople(state.activeId, true);
      } catch (_) {
        refreshed = false;
      }
      const accepted = state.files.filter((entry) => entry.status === "accepted").length;
      const rejected = state.files.filter((entry) => entry.status === "rejected").length;
      const summary = "Saved " + body.person.displayName + ". " + accepted + " photo" + (accepted === 1 ? "" : "s") + " accepted" + (rejected ? "; " + rejected + " need attention." : ".");
      setMessage(summary + (refreshed ? "" : " Saved data is intact, but the directory could not be refreshed."), rejected || !refreshed ? "" : "success");
    } catch (error) {
      setMessage(error.message || "Shiva could not save this person.", "error");
    } finally {
      setBusy(false);
    }
  });

  profileFields.forEach((field) => field.addEventListener("input", () => {
    if (!state.busy) state.dirty = formSignature() !== state.savedSignature;
  }));
  photos.addEventListener("change", () => {
    addFiles(photos.files);
    photos.value = "";
  });
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!state.busy) dropZone.classList.add("drag");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag");
    if (!state.busy) addFiles(event.dataTransfer.files);
  });
  byId("clearPhotos").addEventListener("click", clearFiles);
  byId("newPerson").addEventListener("click", beginNewPerson);
  navLinks.forEach((link) => link.addEventListener("click", (event) => {
    if (!state.busy) return;
    event.preventDefault();
    setMessage("Wait for the current face uploads to finish before leaving this page.", "");
  }));

  window.addEventListener("beforeunload", (event) => {
    if (!hasNavigationRisk()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  byId("identify").addEventListener("click", async () => {
    if (state.busy) return;
    const file = byId("identifyPhoto").files[0];
    const output = byId("identifyResult");
    if (!file) { output.textContent = "Choose a photo first."; return; }
    output.textContent = "Looking for enrolled faces…";
    try {
      const blob = await resizeImage(file);
      const body = await api("/face/identify", { method: "POST", headers: { "content-type": "image/jpeg", accept: "application/json" }, body: blob });
      if (!body.faces.length) { output.textContent = "No faces were detected in that photo."; return; }
      output.textContent = body.faces.map((face, index) => face.match ? "Face " + (index + 1) + ": " + face.match.person.displayName + " (similarity " + face.match.similarity.toFixed(3) + ")" : "Face " + (index + 1) + ": unknown" + (face.ambiguous ? " — result was ambiguous" : "")).join(" · ");
    } catch (error) { output.textContent = error.message || "Recognition failed."; }
  });

  loadPeople().catch((error) => { personList.innerHTML = ""; const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = error.message || "Could not load people."; personList.appendChild(empty); });
})();`;
}
