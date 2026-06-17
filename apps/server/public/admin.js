const modelList = document.querySelector("#modelList");
const folderList = document.querySelector("#folderList");
const refreshButton = document.querySelector("#refreshButton");
const createFolderButton = document.querySelector("#createFolderButton");
const uploadFolderId = document.querySelector("#uploadFolderId");
const selectedFolderLabel = document.querySelector("#selectedFolderLabel");
const modelListTitle = document.querySelector("#modelListTitle");
const refreshStatus = document.querySelector("#refreshStatus");
const dropZone = document.querySelector("#dropZone");
const themeToggle = document.querySelector("#themeToggle");
const fileInput = document.querySelector("#modelFileInput");
const browseButton = document.querySelector("#browseButton");
const topUploadButton = document.querySelector("#topUploadButton");
const modelSearch = document.querySelector("#modelSearch");
const readyMeterLabel = document.querySelector("#readyMeterLabel");
const readyMeterBar = document.querySelector("#readyMeterBar");
const sidebarSummary = document.querySelector("#sidebarSummary");

const state = {
  folders: [],
  models: [],
  currentModels: [],
  selectedFolder: "all",
  pollTimer: null,
  search: ""
};

initTheme();
bindEvents();
start();

function bindEvents() {
  createFolderButton.addEventListener("click", createFolder);
  refreshButton.addEventListener("click", refreshAll);
  browseButton.addEventListener("click", () => fileInput.click());
  topUploadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => uploadSelectedFile(fileInput.files?.[0]));
  modelSearch.addEventListener("input", () => {
    state.search = modelSearch.value.trim().toLowerCase();
    renderModelList(state.currentModels);
  });

  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    await uploadSelectedFile(event.dataTransfer.files?.[0]);
  });
}

function initTheme() {
  const stored = localStorage.getItem("viewer-theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(stored || preferred);
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("viewer-theme", next);
    setTheme(next);
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${theme === "dark" ? "light_mode" : "dark_mode"}</span>`;
  themeToggle.setAttribute("aria-label", theme === "dark" ? "Use light mode" : "Use dark mode");
}

function selectedFolderId() {
  return Number.isInteger(state.selectedFolder) ? state.selectedFolder : null;
}

function selectedFolderName() {
  if (state.selectedFolder === "all") return "All models";
  if (state.selectedFolder === "unsorted") return "Unsorted";
  return state.folders.find((folder) => folder.id === state.selectedFolder)?.name || "Project";
}

function modelCountFor(folderId) {
  if (folderId === "all") return state.models.length;
  if (folderId === "unsorted") return state.models.filter((model) => model.folder_id === null).length;
  return state.folders.find((folder) => folder.id === folderId)?.model_count || 0;
}

function renderFolders() {
  const items = [
    { id: "all", name: "All Models", icon: "folder_open", count: modelCountFor("all") },
    { id: "unsorted", name: "Unsorted", icon: "inbox", count: modelCountFor("unsorted") },
    ...state.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      icon: "folder_shared",
      count: folder.model_count || 0
    }))
  ];

  folderList.innerHTML = items.map((item) => `
    <div class="folder-row ${state.selectedFolder === item.id ? "active" : ""}" data-folder-id="${escapeHtml(item.id)}">
      <button class="folder-button" type="button" data-select-folder="${escapeHtml(item.id)}">
        <span class="material-symbols-outlined" aria-hidden="true">${item.icon}</span>
        <span class="folder-name">${escapeHtml(item.name)}</span>
        <strong>${item.count}</strong>
      </button>
      ${Number.isInteger(item.id) ? `
        <div class="folder-actions">
          <button class="micro-button" type="button" data-rename-folder="${item.id}" title="Rename project" aria-label="Rename ${escapeHtml(item.name)}">
            <span class="material-symbols-outlined" aria-hidden="true">edit</span>
          </button>
          <button class="micro-button danger-text" type="button" data-delete-folder="${item.id}" title="Delete empty project" aria-label="Delete ${escapeHtml(item.name)}">
            <span class="material-symbols-outlined" aria-hidden="true">delete</span>
          </button>
        </div>
      ` : ""}
    </div>
  `).join("");

  folderList.querySelectorAll("[data-select-folder]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.selectFolder;
      state.selectedFolder = raw === "all" || raw === "unsorted" ? raw : Number(raw);
      updateSelectedFolderUi();
      loadModels();
    });
  });

  folderList.querySelectorAll("[data-rename-folder]").forEach((button) => {
    button.addEventListener("click", () => renameFolder(Number(button.dataset.renameFolder)));
  });

  folderList.querySelectorAll("[data-delete-folder]").forEach((button) => {
    button.addEventListener("click", () => deleteFolder(Number(button.dataset.deleteFolder)));
  });
}

function updateSelectedFolderUi() {
  const name = selectedFolderName();
  const folderId = selectedFolderId();
  modelListTitle.textContent = name;
  uploadFolderId.value = folderId ? String(folderId) : "";
  selectedFolderLabel.textContent = `Drop STEP, STP, GLB, or GLTF files into ${folderId ? name : "Unsorted"}.`;
  renderFolders();
}

async function createFolder() {
  const name = window.prompt("Project name");
  if (!name) return;
  const response = await fetch("/api/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) {
    window.alert(`Create failed: ${await response.text()}`);
    return;
  }
  const folder = await response.json();
  state.selectedFolder = folder.id;
  await refreshAll();
}

async function renameFolder(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  const name = window.prompt("New project name", folder?.name || "");
  if (!name) return;
  const response = await fetch(`/api/folders/${folderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) {
    window.alert(`Rename failed: ${await response.text()}`);
    return;
  }
  await loadFolders();
  updateSelectedFolderUi();
}

async function deleteFolder(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  const confirmed = window.confirm(`Delete empty project "${folder?.name || "Project"}"?`);
  if (!confirmed) return;
  const response = await fetch(`/api/folders/${folderId}`, { method: "DELETE" });
  if (!response.ok) {
    window.alert(`Delete failed: ${await response.text()}`);
    return;
  }
  state.selectedFolder = "all";
  await refreshAll();
}

async function deleteModel(slug, name) {
  const confirmed = window.confirm(`Delete this model and all files? This cannot be undone.\n\n${name}`);
  if (!confirmed) return;
  const response = await fetch(`/api/models/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (!response.ok) {
    window.alert(`Delete failed: ${await response.text()}`);
    return;
  }
  await refreshAll();
}

async function moveModel(slug, folderId) {
  const response = await fetch(`/api/models/${encodeURIComponent(slug)}/folder`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderId: folderId || null })
  });
  if (!response.ok) {
    window.alert(`Move failed: ${await response.text()}`);
    return;
  }
  await refreshAll();
}

async function uploadSelectedFile(file) {
  if (!file) return;
  const form = new FormData();
  form.set("modelFile", file);
  const folderId = selectedFolderId();
  if (folderId) form.set("folderId", String(folderId));

  selectedFolderLabel.textContent = `Uploading ${file.name} into ${folderId ? selectedFolderName() : "Unsorted"}...`;
  const response = await fetch("/api/models", { method: "POST", body: form, redirect: "manual" });
  fileInput.value = "";
  if (!response.ok && response.status !== 0) {
    window.alert(`Upload failed: ${await response.text()}`);
  }
  await refreshAll();
}

async function loadFolders() {
  const response = await fetch("/api/folders");
  if (!response.ok) {
    folderList.textContent = "Could not load projects.";
    return;
  }
  state.folders = await response.json();
  renderFolders();
}

async function loadModels() {
  const query = state.selectedFolder === "unsorted"
    ? "?folder=unsorted"
    : Number.isInteger(state.selectedFolder)
      ? `?folder=${state.selectedFolder}`
      : "";

  modelList.textContent = "Loading...";
  const response = await fetch(`/api/models${query}`);
  if (!response.ok) {
    modelList.textContent = "Could not load uploaded models.";
    return;
  }

  const models = await response.json();
  state.currentModels = models;
  if (state.selectedFolder === "all") state.models = models;
  renderModelList(models);
  schedulePolling(models);
}

async function refreshAll() {
  await loadFolders();
  await loadModels();
  updateSelectedFolderUi();
}

function renderModelList(models) {
  const filtered = state.search
    ? models.filter((model) => [model.name, model.slug, model.source_filename, model.status].some((value) => String(value || "").toLowerCase().includes(state.search)))
    : models;

  refreshStatus.textContent = `Updated ${new Date().toLocaleTimeString()}.`;
  updateInventorySummary();

  if (filtered.length === 0) {
    modelList.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" aria-hidden="true">deployed_code_off</span>
        <p>${state.search ? "No models match the current search." : "No models in this view yet."}</p>
      </div>
    `;
    return;
  }

  const folderOptions = [
    '<option value="">Unsorted</option>',
    ...state.folders.map((folder) => `<option value="${folder.id}">${escapeHtml(folder.name)}</option>`)
  ].join("");

  modelList.innerHTML = `
    <div class="asset-table-wrap">
      <table class="asset-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Created</th>
            <th>Project</th>
            <th class="actions-heading">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map((model) => `
            <tr>
              <td class="asset-name-cell">
                <span class="model-thumb material-symbols-outlined" aria-hidden="true">${model.has_display_glb ? "view_in_ar" : "model_training"}</span>
                <div>
                  <strong>${escapeHtml(model.name)}</strong>
                  <span>${escapeHtml(model.source_filename)}</span>
                  <code>${escapeHtml(model.slug)}</code>
                </div>
              </td>
              <td>${renderStatus(model.status)}</td>
              <td class="date-cell">${escapeHtml(formatDate(model.created_at))}</td>
              <td class="folder-cell">
                <select data-move-model="${escapeHtml(model.slug)}" aria-label="Move ${escapeHtml(model.name)} to project">
                  ${folderOptions}
                </select>
              </td>
              <td class="row-actions">
                <a class="row-button ${model.has_display_glb ? "primary-row-action" : "disabled"}" href="/3dviewer/${encodeURIComponent(model.slug)}" ${model.has_display_glb ? "" : "aria-disabled=\"true\" tabindex=\"-1\""} title="Open viewer">
                  <span class="material-symbols-outlined" aria-hidden="true">visibility</span>
                </a>
                <a class="row-button" href="/downloads/${encodeURIComponent(model.slug)}/original" title="Download original">
                  <span class="material-symbols-outlined" aria-hidden="true">source</span>
                </a>
                ${model.has_display_glb ? `
                  <a class="row-button" href="/downloads/${encodeURIComponent(model.slug)}/display.glb" title="Download GLB">
                    <span class="material-symbols-outlined" aria-hidden="true">download</span>
                  </a>
                ` : `
                  <span class="row-button disabled" title="GLB not ready"><span class="material-symbols-outlined" aria-hidden="true">download</span></span>
                `}
                <a class="row-button" href="/admin/logs/${encodeURIComponent(model.slug)}/conversion.log" title="Open conversion log">
                  <span class="material-symbols-outlined" aria-hidden="true">list_alt</span>
                </a>
                <a class="row-button" href="/admin/models/${encodeURIComponent(model.slug)}/material-debug.json" title="Open material debug">
                  <span class="material-symbols-outlined" aria-hidden="true">data_object</span>
                </a>
                <a class="row-button" href="/admin/models/${encodeURIComponent(model.slug)}/xcaf-report.json" title="Open XCAF report">
                  <span class="material-symbols-outlined" aria-hidden="true">account_tree</span>
                </a>
                <button class="row-button danger-row-action" type="button" data-delete-slug="${escapeHtml(model.slug)}" data-delete-name="${escapeHtml(model.name)}" title="Delete model">
                  <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                </button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  modelList.querySelectorAll("[data-move-model]").forEach((select) => {
    const model = filtered.find((item) => item.slug === select.dataset.moveModel);
    select.value = model?.folder_id ? String(model.folder_id) : "";
    select.addEventListener("change", () => moveModel(select.dataset.moveModel, select.value));
  });

  modelList.querySelectorAll("[data-delete-slug]").forEach((button) => {
    button.addEventListener("click", () => deleteModel(button.dataset.deleteSlug, button.dataset.deleteName));
  });
}

function renderStatus(status) {
  const stage = statusStage(status);
  return `
    <div class="status-wrap">
      <span class="status status-${escapeHtml(stage.kind)}"><span></span>${escapeHtml(stage.label)}</span>
      <div class="progress ${stage.indeterminate ? "indeterminate" : ""}" aria-label="${escapeHtml(stage.label)}">
        <span style="width: ${stage.percent}%"></span>
      </div>
    </div>
  `;
}

function statusStage(status) {
  if (status === "ready") return { kind: "ready", percent: 100, label: "Ready", indeterminate: false };
  if (status === "failed") return { kind: "failed", percent: 100, label: "Failed", indeterminate: false };
  if (status === "processing") return { kind: "processing", percent: 55, label: "Processing", indeterminate: true };
  if (status === "queued" || status === "uploaded") return { kind: "queued", percent: 25, label: status === "uploaded" ? "Uploaded" : "Queued", indeterminate: false };
  return { kind: "queued", percent: 15, label: status || "Waiting", indeterminate: true };
}

function updateInventorySummary() {
  const total = state.models.length || state.currentModels.length;
  const ready = state.models.filter((model) => model.status === "ready").length;
  const active = state.models.filter((model) => ["uploaded", "queued", "processing"].includes(model.status)).length;
  const percent = total ? Math.round((ready / total) * 100) : 0;
  readyMeterLabel.textContent = `${percent}%`;
  readyMeterBar.style.width = `${percent}%`;
  sidebarSummary.textContent = `${total} models, ${ready} ready, ${active} active conversions.`;
}

function schedulePolling(models) {
  window.clearTimeout(state.pollTimer);
  const active = models.some((model) => ["uploaded", "queued", "processing"].includes(model.status));
  const delay = active ? 3000 : 15000;
  refreshStatus.textContent += active ? " Watching active conversions." : " Next quiet refresh in 15s.";
  state.pollTimer = window.setTimeout(refreshAll, delay);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

async function start() {
  await refreshAll();
}
