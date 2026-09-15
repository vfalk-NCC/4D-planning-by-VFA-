/* =========================================================================
   4D-planering – Trimble Connect Extension
   ---------------------------------------------------------------------
   Data lagras direkt i Trimble Connect-projektets egen filyta (en JSON-
   fil i mappen "4D-planering-data") istället för en egen server. Samma
   autentiserings- och uppladdningsmönster som i "Quick viewer by VFA"
   (verifierat fungerande mot riktig TC-miljö, EU-region/app21).
   ========================================================================= */

let API = null;              // Workspace API-instans
let projectId = null;        // Aktuellt Trimble Connect-projekt
let items = [];              // Cache av planeringsposter
let settings = {
  colorNotStarted: "#c9ccd1", // grå
  colorInProgress: "#f5a623", // orange
  colorDone: "#3fb950"        // grön
};
let lastSelection = [];
let playTimer = null;
let searchTerm = "";

/* ---------------------------------------------------------------------
   Trimble Connect REST-lagring (ersätter tidigare egna backend/databas)
   ------------------------------------------------------------------- */
const TC_CONFIG = {
  // EU-region (app21), samma som verifierats i Quick Viewer-extensionen.
  // Byt till "app.connect.trimble.com" (US), "app22..." (UK) etc. om ert
  // projekt ligger i en annan Trimble Connect-region.
  API_REGION_HOST: "app21.connect.trimble.com",
  DATA_FOLDER_NAME: "4D-planering-data",
  DATA_FILE_NAME: "4dplan-data.json"
};

let tcAccessToken = null;
let _pendingAccessTokenResolvers = [];
let _dataFolderIdCache = null;

function tcApiUrl(path) {
  return `https://${TC_CONFIG.API_REGION_HOST}/tc/api/2.0${path}`;
}

async function tcErrBody(res) {
  let text = "";
  try { text = await res.text(); } catch (e) { /* ignorera */ }
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    return j.message || j.error || JSON.stringify(j).slice(0, 300);
  } catch { return text.slice(0, 300); }
}

async function tcFetchJson(path) {
  const res = await fetch(tcApiUrl(path), { headers: { Authorization: `Bearer ${tcAccessToken}` } });
  if (!res.ok) {
    const body = await tcErrBody(res);
    throw new Error(`TC API-anrop misslyckades (${res.status}): ${path}${body ? " — " + body : ""}`);
  }
  return await res.json();
}

/**
 * Begär en access token för REST-anrop mot Trimble Connect Core API.
 * Workspace API:t (viewer/selection) kräver ingen sådan token, men
 * fil-lagring gör det. Trimble Connect visar en godkännandedialog för
 * användaren första gången — se statusraden i UI:t medan vi väntar.
 */
async function authenticate() {
  if (!API?.extension?.requestPermission) {
    throw new Error("extension.requestPermission saknas i api-ytan — kontrollera SDK-version.");
  }

  const tokenPromise = new Promise((resolve, reject) => {
    _pendingAccessTokenResolvers.push(resolve);
    setTimeout(() => reject(new Error(
      "Timeout: fick inget extension.accessToken-event inom 60s. Kontrollera om Trimble Connect " +
      "visade en behörighetsdialog som väntar på klick."
    )), 60000);
  });

  const status = await API.extension.requestPermission("accesstoken");
  if (status && status !== "granted" && status !== "denied" && status !== "pending" && status.length > 20) {
    // Vissa SDK-versioner returnerar token direkt istället för status.
    const resolvers = _pendingAccessTokenResolvers.splice(0);
    resolvers.forEach(r => r(status));
  } else if (status === "denied") {
    throw new Error("Åtkomst till accesstoken nekades av användaren.");
  }

  const token = await tokenPromise;
  if (!token) throw new Error("Access token saknades i extension.accessToken-eventet.");
  return token;
}

async function getProjectRootId() {
  const project = await tcFetchJson(`/projects/${projectId}`);
  if (!project.rootId) throw new Error("Kunde inte hitta projektets rotmapp (rootId).");
  return project.rootId;
}

async function ensureDataFolder() {
  if (_dataFolderIdCache) return _dataFolderIdCache;
  const rootId = await getProjectRootId();
  const res = await tcFetchJson(`/folders/${rootId}/items`);
  const list = Array.isArray(res) ? res : res?.items || [];
  const existing = list.find(it => it.type === "FOLDER" && it.name === TC_CONFIG.DATA_FOLDER_NAME);
  if (existing) { _dataFolderIdCache = existing.id; return existing.id; }

  const createRes = await fetch(tcApiUrl(`/folders`), {
    method: "POST",
    headers: { Authorization: `Bearer ${tcAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: TC_CONFIG.DATA_FOLDER_NAME, parentId: rootId })
  });
  if (!createRes.ok) {
    const body = await tcErrBody(createRes);
    throw new Error(`Kunde inte skapa datamapp (${createRes.status})${body ? " — " + body : ""}`);
  }
  const folder = await createRes.json();
  _dataFolderIdCache = folder.id;
  return folder.id;
}

async function findDataFile(folderId) {
  const res = await tcFetchJson(`/folders/${folderId}/items`);
  const list = Array.isArray(res) ? res : res?.items || [];
  return list.find(it => it.type === "FILE" && it.name === TC_CONFIG.DATA_FILE_NAME) || null;
}

/**
 * Laddar upp en fil till en mapp. Hanterar både enkel och flerdelad
 * (multipart) uppladdning enligt Trimbles fs/upload-flöde.
 */
async function uploadFileToFolder(folderId, filename, blob) {
  const initRes = await fetch(tcApiUrl(`/files/fs/upload?parentId=${encodeURIComponent(folderId)}&parentType=FOLDER`), {
    method: "POST",
    headers: { Authorization: `Bearer ${tcAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: filename })
  });
  if (!initRes.ok) {
    const body = await tcErrBody(initRes);
    throw new Error(`Kunde inte initiera uppladdning (${initRes.status})${body ? " — " + body : ""}`);
  }
  const initData = await initRes.json();
  const uploadId = initData.uploadId;
  const contents = Array.isArray(initData.contents) ? initData.contents : [];
  if (!uploadId || !contents.length || !contents[0]?.url) throw new Error("Ofullständigt svar från uppladdnings-initiering.");
  const isMultipart = contents.length > 1;

  const bytes = await blob.arrayBuffer();
  const parts = [];
  for (let i = 0; i < contents.length; i++) {
    const part = contents[i];
    const start = typeof part.byteOffset === "number" ? part.byteOffset : 0;
    const size = typeof part.size === "number" ? part.size : bytes.byteLength;
    const chunk = isMultipart ? bytes.slice(start, start + size) : bytes;
    const putRes = await fetch(part.url, { method: "PUT", body: chunk });
    if (!putRes.ok) {
      const body = await tcErrBody(putRes);
      throw new Error(`Filöverföring misslyckades (del ${i + 1}/${contents.length}, ${putRes.status})${body ? " — " + body : ""}`);
    }
    if (isMultipart) {
      const rawEtag = putRes.headers.get("ETag") || putRes.headers.get("etag");
      if (!rawEtag) throw new Error(`Del ${i + 1}/${contents.length} gav inget läsbart ETag-svarshuvud — kan inte slutföra flerdelad uppladdning.`);
      parts.push({ etag: rawEtag.replace(/^"|"$/g, ""), part_number: typeof part.partNumber === "number" ? part.partNumber : i + 1 });
    }
  }

  const commitBody = { uploadId };
  if (isMultipart) commitBody.multipart = { upload: { parts } };

  const commitRes = await fetch(tcApiUrl(`/files/fs/commit`), {
    method: "POST",
    headers: { Authorization: `Bearer ${tcAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(commitBody)
  });
  if (!commitRes.ok) {
    const body = await tcErrBody(commitRes);
    throw new Error(`Kunde inte slutföra uppladdning (${commitRes.status})${body ? " — " + body : ""}`);
  }
  let result = await commitRes.json();

  for (let i = 0; i < 10 && result.status && result.status !== "DONE" && result.status !== "ERROR"; i++) {
    await new Promise(r => setTimeout(r, 800));
    result = await tcFetchJson(`/files/fs/uploadstatus?uploadId=${encodeURIComponent(uploadId)}`);
  }
  if (result.status === "ERROR") throw new Error(`Uppladdning misslyckades: ${result.errorReason || "okänt fel"}`);
  if (!result.fileId) throw new Error("Fick inget fileId tillbaka efter uppladdning.");
  return { fileId: result.fileId, versionId: result.versionId };
}

async function deleteFile(fileId) {
  try {
    await fetch(tcApiUrl(`/files/${fileId}`), { method: "DELETE", headers: { Authorization: `Bearer ${tcAccessToken}` } });
  } catch (e) { console.warn("Kunde inte ta bort gammal datafil:", e); }
}

async function loadItemsFromTC() {
  const folderId = await ensureDataFolder();
  const file = await findDataFile(folderId);
  if (!file) return [];
  const { url } = await tcFetchJson(`/files/fs/${file.id}/downloadurl`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kunde inte ladda ner planeringsdata (${res.status})`);
  const text = await res.text();
  try { return JSON.parse(text) || []; } catch (e) { console.error("Ogiltig JSON i datafilen:", e); return []; }
}

/**
 * Skriver hela planeringslistan till Trimble Connect. Eftersom Core API:t
 * inte enkelt stödjer "uppdatera innehållet i befintlig fil" via detta
 * flöde, tas den gamla filen bort och en ny laddas upp med samma namn —
 * samma mönster som redan används för filuppladdning i extensionen.
 */
async function saveItemsToTC(itemsToSave) {
  const folderId = await ensureDataFolder();
  const existing = await findDataFile(folderId);
  const blob = new Blob([JSON.stringify(itemsToSave, null, 2)], { type: "application/json" });
  if (existing) await deleteFile(existing.id);
  await uploadFileToFolder(folderId, TC_CONFIG.DATA_FILE_NAME, blob);
}

function mergeItems(records) {
  records.forEach(rec => {
    const idx = items.findIndex(it => it.objectId === rec.objectId && it.modelId === rec.modelId);
    if (idx >= 0) items[idx] = { ...items[idx], ...rec };
    else items.push(rec);
  });
}

/* ---------------------------------------------------------------------
   Init
   ------------------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", init);

async function init() {
  loadLocalSettings();
  bindUI();
  setTcStatus("Ansluter till Trimble Connect...");

  API = await TrimbleConnectWorkspace.connect(window.parent, onWorkspaceEvent, 30000);

  const project = await API.project.getProject();
  projectId = project.id;

  setTcStatus("Begär åtkomst till projektets filyta – godkänn ev. dialog i Trimble Connect...");
  try {
    tcAccessToken = await authenticate();
  } catch (e) {
    console.error(e);
    setTcStatus("Kunde inte få åtkomst: " + e.message, true);
    return;
  }

  setTcStatus("Läser in sparad planering...");
  try {
    items = await loadItemsFromTC();
    setTcStatus("");
  } catch (e) {
    console.error(e);
    setTcStatus("Kunde inte läsa planeringsdata: " + e.message, true);
    items = [];
  }

  buildFilterOptions();
  renderItemList();
  initTimelineRange();
}

function setTcStatus(text, isError) {
  const el = document.getElementById("tcStatus");
  if (!el) return;
  el.innerText = text || "";
  el.style.color = isError ? "#e05b5b" : "";
}

function onWorkspaceEvent(event, data) {
  if (event === "viewer.onSelectionChanged" || event === "extension.onSelectionChanged") {
    refreshSelectionCount();
  }
  if (event === "extension.accessToken") {
    const token = data?.data;
    tcAccessToken = token || null;
    const resolvers = _pendingAccessTokenResolvers.splice(0);
    resolvers.forEach(r => r(token));
  }
}

/* ---------------------------------------------------------------------
   UI-koppling
   ------------------------------------------------------------------- */
function bindUI() {
  document.getElementById("btnLinkSelection").onclick = onOpenLinkForm;
  document.getElementById("btnCancelLink").onclick = () => toggle("linkForm", false);
  document.getElementById("btnSaveLink").onclick = onSaveLink;

  document.getElementById("timelineSlider").oninput = onSliderMove;
  document.getElementById("timelineDate").onchange = onDateInputChange;
  document.getElementById("btnPlay").onclick = onTogglePlay;

  document.getElementById("btnApplyFilter").onclick = applyFilterToModel;
  document.getElementById("btnClearFilter").onclick = clearFilter;

  document.getElementById("btnImportExcel").onclick = onImportExcel;

  document.getElementById("itemSearch").oninput = () => renderItemList();

  document.getElementById("btnSettings").onclick = () => toggle("settingsDialog", true);
  document.getElementById("btnCloseSettings").onclick = () => toggle("settingsDialog", false);
  document.getElementById("btnSaveSettings").onclick = onSaveSettings;

  document.getElementById("colorNotStarted").value = settings.colorNotStarted;
  document.getElementById("colorInProgress").value = settings.colorInProgress;
  document.getElementById("colorDone").value = settings.colorDone;
  paintLegendDots();
}

function toggle(id, show) {
  document.getElementById(id).classList.toggle("hidden", !show);
}

function paintLegendDots() {
  document.getElementById("dotNotStarted").style.background = settings.colorNotStarted;
  document.getElementById("dotInProgress").style.background = settings.colorInProgress;
  document.getElementById("dotDone").style.background = settings.colorDone;
}

/* ---------------------------------------------------------------------
   Inställningar (bara färger nu — lagras lokalt per webbläsare)
   ------------------------------------------------------------------- */
function loadLocalSettings() {
  try {
    const raw = window.localStorage.getItem("4dplan-settings");
    if (raw) settings = { ...settings, ...JSON.parse(raw) };
  } catch (e) { /* ignorera */ }
}

function onSaveSettings() {
  settings.colorNotStarted = document.getElementById("colorNotStarted").value;
  settings.colorInProgress = document.getElementById("colorInProgress").value;
  settings.colorDone = document.getElementById("colorDone").value;
  window.localStorage.setItem("4dplan-settings", JSON.stringify(settings));
  paintLegendDots();
  toggle("settingsDialog", false);
  applyTimelineColors();
}

/* ---------------------------------------------------------------------
   Koppla markerade objekt till planeringsdata
   ------------------------------------------------------------------- */
async function refreshSelectionCount() {
  const sel = await API.viewer.getSelection();
  const count = (sel || []).reduce((n, m) => n + (m.objectRuntimeIds ? m.objectRuntimeIds.length : 0), 0);
  document.getElementById("selCount").innerText = count;
}

async function onOpenLinkForm() {
  const selection = await API.viewer.getSelection();
  lastSelection = [];

  for (const modelSel of selection || []) {
    const externalIds = await API.viewer.convertToObjectIds(modelSel.modelId, modelSel.objectRuntimeIds);
    modelSel.objectRuntimeIds.forEach((runtimeId, i) => {
      lastSelection.push({ modelId: modelSel.modelId, objectId: externalIds[i], objectRuntimeId: runtimeId });
    });
  }

  document.getElementById("selCount").innerText = lastSelection.length;

  if (lastSelection.length === 0) {
    alert("Markera minst ett objekt i modellen först.");
    return;
  }

  const existing = items.find(it => lastSelection.some(s => s.objectId === it.objectId && s.modelId === it.modelId));
  fillLinkForm(existing);
  toggle("linkForm", true);
}

function editItemFromList(item) {
  lastSelection = [{ modelId: item.modelId, objectId: item.objectId }];
  document.getElementById("selCount").innerText = 1;
  fillLinkForm(item);
  toggle("linkForm", true);
}

function fillLinkForm(existing) {
  document.getElementById("fName").value = existing ? existing.objectName || "" : "";
  document.getElementById("fArea").value = existing ? existing.area || "" : "";
  document.getElementById("fActivity").value = existing ? existing.activity || "" : "";
  document.getElementById("fContractor").value = existing ? existing.contractor || "" : "";
  document.getElementById("fStatus").value = existing ? existing.status || "planerad" : "planerad";
  document.getElementById("fStart").value = existing ? existing.startDate || "" : "";
  document.getElementById("fEnd").value = existing ? existing.endDate || "" : "";
}

async function onSaveLink() {
  const payload = {
    objectName: document.getElementById("fName").value.trim(),
    area: document.getElementById("fArea").value.trim(),
    activity: document.getElementById("fActivity").value.trim(),
    contractor: document.getElementById("fContractor").value.trim(),
    status: document.getElementById("fStatus").value,
    startDate: document.getElementById("fStart").value || null,
    endDate: document.getElementById("fEnd").value || null
  };

  const records = lastSelection.map(s => ({ modelId: s.modelId, objectId: s.objectId, ...payload }));
  mergeItems(records);

  try {
    setTcStatus("Sparar till Trimble Connect...");
    await saveItemsToTC(items);
    setTcStatus("");
  } catch (e) {
    alert("Kunde inte spara: " + e.message);
    return;
  }

  toggle("linkForm", false);
  buildFilterOptions();
  renderItemList();
  applyTimelineColors();
}

/* ---------------------------------------------------------------------
   Tidslinje
   ------------------------------------------------------------------- */
function initTimelineRange() {
  const dates = items.flatMap(it => [it.startDate, it.endDate]).filter(Boolean).sort();
  const dateInput = document.getElementById("timelineDate");
  const today = new Date().toISOString().slice(0, 10);
  dateInput.value = dates.length ? dates[0] : today;

  const slider = document.getElementById("timelineSlider");
  if (dates.length >= 2) {
    slider.min = 0;
    slider.max = daysBetween(dates[0], dates[dates.length - 1]);
    slider.value = 0;
  }
  applyTimelineColors();
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function onSliderMove() {
  const start = getEarliestDate();
  if (!start) return;
  const slider = document.getElementById("timelineSlider");
  const newDate = new Date(start);
  newDate.setDate(newDate.getDate() + Number(slider.value));
  document.getElementById("timelineDate").value = newDate.toISOString().slice(0, 10);
  applyTimelineColors();
}

function onDateInputChange() {
  const start = getEarliestDate();
  const cur = document.getElementById("timelineDate").value;
  if (start && cur) {
    document.getElementById("timelineSlider").value = daysBetween(start, cur);
  }
  applyTimelineColors();
}

function getEarliestDate() {
  const dates = items.map(it => it.startDate).filter(Boolean).sort();
  return dates[0] || null;
}

function onTogglePlay() {
  const btn = document.getElementById("btnPlay");
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
    btn.innerText = "▶";
    return;
  }
  btn.innerText = "⏸";
  playTimer = setInterval(() => {
    const slider = document.getElementById("timelineSlider");
    const next = Number(slider.value) + 1;
    if (next > Number(slider.max)) { onTogglePlay(); return; }
    slider.value = next;
    onSliderMove();
  }, 400);
}

async function applyTimelineColors() {
  const selectedDate = document.getElementById("timelineDate").value;
  if (!selectedDate || items.length === 0) return;

  const byModel = {};
  for (const it of items) {
    if (!it.startDate) continue;
    const phase = getPhase(it, selectedDate);
    byModel[it.modelId] = byModel[it.modelId] || { notStarted: [], inProgress: [], done: [] };
    byModel[it.modelId][phase].push(it.objectId);
  }

  for (const modelId of Object.keys(byModel)) {
    const group = byModel[modelId];
    await colorGroup(modelId, group.notStarted, settings.colorNotStarted);
    await colorGroup(modelId, group.inProgress, settings.colorInProgress);
    await colorGroup(modelId, group.done, settings.colorDone);
  }
}

function getPhase(item, selectedDateStr) {
  const d = new Date(selectedDateStr);
  const start = new Date(item.startDate);
  const end = item.endDate ? new Date(item.endDate) : start;
  if (d < start) return "notStarted";
  if (d >= start && d <= end) return "inProgress";
  return "done";
}

async function colorGroup(modelId, externalIds, colorHex) {
  if (externalIds.length === 0) return;
  const runtimeIds = await API.viewer.convertToObjectRuntimeIds(modelId, externalIds);
  const valid = runtimeIds.filter(id => id !== undefined && id !== null);
  if (valid.length === 0) return;
  await API.viewer.setObjectState(
    { modelObjectIds: [{ modelId, objectRuntimeIds: valid }] },
    { color: hexToRgba(colorHex) }
  );
}

function hexToRgba(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b, a: 255 };
}

/* ---------------------------------------------------------------------
   Filter
   ------------------------------------------------------------------- */
function buildFilterOptions() {
  fillDatalist("areaList", unique(items.map(i => i.area)));
  fillDatalist("activityList", unique(items.map(i => i.activity)));
  fillDatalist("contractorList", unique(items.map(i => i.contractor)));

  fillMultiSelect("filterArea", unique(items.map(i => i.area)));
  fillMultiSelect("filterActivity", unique(items.map(i => i.activity)));
  fillMultiSelect("filterContractor", unique(items.map(i => i.contractor)));

  const statusEl = document.getElementById("filterStatus");
  const statusLabels = { planerad: "Planerad", pagaende: "Pågående", forsenad: "Försenad", klar: "Klar", pausad: "Pausad" };
  statusEl.innerHTML = Object.entries(statusLabels)
    .map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))].sort();
}

function fillDatalist(id, values) {
  const el = document.getElementById(id);
  el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">`).join("");
}

function fillMultiSelect(id, values) {
  const el = document.getElementById(id);
  el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}

function getSelectedValues(id) {
  return Array.from(document.getElementById(id).selectedOptions).map(o => o.value);
}

async function applyFilterToModel() {
  const statusEl = document.getElementById("filterMsg");
  statusEl.innerText = "Filtrerar...";

  const areas = getSelectedValues("filterArea");
  const activities = getSelectedValues("filterActivity");
  const contractors = getSelectedValues("filterContractor");
  const statuses = getSelectedValues("filterStatus");
  const weeks = document.getElementById("filterWeeks").value;

  let matched = items.filter(it => {
    if (areas.length && !areas.includes(it.area)) return false;
    if (activities.length && !activities.includes(it.activity)) return false;
    if (contractors.length && !contractors.includes(it.contractor)) return false;
    if (statuses.length && !statuses.includes(it.status)) return false;
    if (weeks && it.startDate) {
      const limit = new Date();
      limit.setDate(limit.getDate() + Number(weeks) * 7);
      if (new Date(it.startDate) > limit) return false;
    }
    return true;
  });

  if (matched.length === 0) {
    statusEl.innerText = "Inga sparade objekt matchar filtret.";
    return;
  }

  const byModel = {};
  matched.forEach(it => {
    if (!it.modelId) return;
    byModel[it.modelId] = byModel[it.modelId] || [];
    byModel[it.modelId].push(it.objectId);
  });

  try {
    await API.viewer.setObjectState(undefined, { visible: false });

    let firstGroup = true;
    for (const modelId of Object.keys(byModel)) {
      const runtimeIds = await API.viewer.convertToObjectRuntimeIds(modelId, byModel[modelId]);
      const valid = runtimeIds.filter(id => id !== undefined && id !== null);
      if (valid.length === 0) continue;

      const selector = { modelObjectIds: [{ modelId, objectRuntimeIds: valid }] };
      await API.viewer.setObjectState(selector, { visible: true });
      await API.viewer.setSelection(selector, firstGroup ? "set" : "add");
      firstGroup = false;
    }
    statusEl.innerText = `Visar ${matched.length} matchande objekt.`;
  } catch (e) {
    console.error(e);
    statusEl.innerText = "Kunde inte filtrera modellen: " + e.message;
  }
}

async function clearFilter() {
  ["filterArea", "filterActivity", "filterContractor", "filterStatus"].forEach(id => {
    Array.from(document.getElementById(id).options).forEach(o => o.selected = false);
  });
  document.getElementById("filterWeeks").value = "";
  document.getElementById("filterMsg").innerText = "";
  await API.viewer.setObjectState(undefined, { visible: "reset" });
  applyTimelineColors();
}

/* ---------------------------------------------------------------------
   Excel-import
   ------------------------------------------------------------------- */
async function onImportExcel() {
  const fileInput = document.getElementById("excelFile");
  const status = document.getElementById("importStatus");
  if (!fileInput.files.length) {
    status.innerText = "Välj en Excel-fil först.";
    return;
  }
  status.innerText = "Läser fil...";
  const rows = await parseExcelFile(fileInput.files[0]);
  const records = rows.map(r => ({
    modelId: r["ModellID"] || items[0]?.modelId || null,
    objectId: String(r["ObjektID"] || r["ObjectId"] || "").trim(),
    objectName: r["Namn"] || r["Name"] || "",
    area: r["Område"] || r["Area"] || "",
    activity: r["Aktivitet"] || r["Activity"] || "",
    contractor: r["Entreprenör"] || r["Contractor"] || "",
    status: normalizeStatus(r["Status"]),
    startDate: excelDateToIso(r["Startdatum"] || r["StartDate"]),
    endDate: excelDateToIso(r["Slutdatum"] || r["EndDate"])
  })).filter(r => r.objectId);

  mergeItems(records);

  status.innerText = `Sparar ${records.length} rader till Trimble Connect...`;
  try {
    await saveItemsToTC(items);
  } catch (e) {
    status.innerText = "Kunde inte spara: " + e.message;
    return;
  }

  buildFilterOptions();
  renderItemList();
  applyTimelineColors();
  status.innerText = `Klart – ${records.length} objekt uppdaterade.`;
}

function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(sheet, { defval: "" }));
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function excelDateToIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeStatus(value) {
  const map = { "planerad": "planerad", "pågående": "pagaende", "försenad": "forsenad", "klar": "klar", "pausad": "pausad" };
  return map[String(value || "").toLowerCase()] || "planerad";
}

/* ---------------------------------------------------------------------
   Objektlista
   ------------------------------------------------------------------- */
function renderItemList() {
  searchTerm = (document.getElementById("itemSearch").value || "").toLowerCase().trim();

  const visible = items.filter(it => {
    if (!searchTerm) return true;
    const haystack = [it.objectName, it.area, it.activity, it.contractor, it.objectId]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(searchTerm);
  });

  document.getElementById("itemCount").innerText = `${visible.length}/${items.length}`;
  const el = document.getElementById("itemList");
  const statusColor = { planerad: "#94a3b8", pagaende: "#f5a623", forsenad: "#e5484d", klar: "#3fb950", pausad: "#a1a1aa" };
  const statusLabel = { planerad: "Planerad", pagaende: "Pågående", forsenad: "Försenad", klar: "Klar", pausad: "Pausad" };

  if (visible.length === 0) {
    el.innerHTML = `<div class="hint">Inga objekt ${searchTerm ? "matchar sökningen" : "sparade ännu"}.</div>`;
    return;
  }

  el.innerHTML = visible.map((it, i) => `
    <div class="item-row" data-index="${i}">
      <span class="item-main" data-action="select">
        <span class="item-name">${escapeHtml(it.objectName || it.objectId)}</span><br/>
        <span>${escapeHtml(it.area || "–")} · ${escapeHtml(it.activity || "–")}</span>
      </span>
      <span class="badge" style="background:${statusColor[it.status] || "#999"}">${statusLabel[it.status] || it.status}</span>
      <button class="edit-btn" data-action="edit" title="Redigera">✏️</button>
    </div>
  `).join("");

  Array.from(el.querySelectorAll(".item-row")).forEach(row => {
    const it = visible[Number(row.dataset.index)];

    row.querySelector('[data-action="select"]').onclick = async () => {
      if (!it.modelId) { alert("Objektet saknar modell-koppling (troligen från Excel utan ModellID)."); return; }
      const runtimeIds = await API.viewer.convertToObjectRuntimeIds(it.modelId, [it.objectId]);
      const valid = runtimeIds.filter(id => id !== undefined && id !== null);
      if (valid.length === 0) { alert("Hittade inte objektet i den just nu inlästa modellen."); return; }
      await API.viewer.setSelection({ modelObjectIds: [{ modelId: it.modelId, objectRuntimeIds: valid }] }, "set");
      await API.viewer.setCamera({ modelObjectIds: [{ modelId: it.modelId, objectRuntimeIds: valid }] });
    };

    row.querySelector('[data-action="edit"]').onclick = () => editItemFromList(it);
  });
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
