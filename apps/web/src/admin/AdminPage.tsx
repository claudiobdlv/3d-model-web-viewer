import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArchiveRestore, ArrowDown, ArrowUp, Box, Check, ChevronRight, Copy, Download, Folder,
  FolderOpen, HardDrive, History, List, Loader2, LogOut, Moon, MoreVertical, Pencil, Plus, QrCode,
  RefreshCw, Replace, Search, Share2, Sun, Trash2, Upload, X
} from "lucide-react";
import {
  batchModels, createProject, createPublicShare, deleteProject, getAppConfig, getPublicShareSettings, getStorageQuota,
  listLibraryModels, listProjects, renameModel, renameProject, uploadModel,
  initChunkedUpload, uploadChunk, completeChunkedUpload, deleteChunkedUpload,
  getModel, makeRevisionCurrent, replaceRevision, updateRevisionPublicSelectable, uploadNewRevision,
  getMe, postLogout
} from "../api";
import type { MeResponse } from "../api";
import { downloadPublicShareQr } from "../qr";
import type { BatchAction, ConversionQuality, MeshiqAdaptiveSmoothing, ModelListParams, ModelRecord, ModelRevisionRecord, ProjectRecord, PublicShareLinkMode, StorageQuota, UploadTask } from "../types";
import { activeStatuses, formatDate, formatFileSize, statusKind, statusLabel } from "../utils";
import { ResizableHeaderCell } from "./ResizableHeaderCell";

type View = { kind: "all" | "projects" | "unsorted" | "trash" } | { kind: "project"; id: number };
type SortBy = NonNullable<ModelListParams["sortBy"]>;
type ColumnKey = "name" | "project" | "revision" | "status" | "quality" | "glbSize" | "created";
const columnDefinitions: Array<{ key: ColumnKey; label: string; sortKey?: SortBy; defaultWidth: number; minWidth: number; maxWidth: number }> = [
  { key: "name", label: "Name", sortKey: "name", defaultWidth: 280, minWidth: 190, maxWidth: 520 },
  { key: "project", label: "Project", sortKey: "project", defaultWidth: 150, minWidth: 100, maxWidth: 320 },
  { key: "revision", label: "Revision", defaultWidth: 105, minWidth: 90, maxWidth: 180 },
  { key: "status", label: "Status", sortKey: "status", defaultWidth: 120, minWidth: 100, maxWidth: 220 },
  { key: "quality", label: "Quality", defaultWidth: 90, minWidth: 78, maxWidth: 150 },
  { key: "glbSize", label: "GLB size", sortKey: "glb_size_bytes", defaultWidth: 105, minWidth: 88, maxWidth: 180 },
  { key: "created", label: "Date", sortKey: "created_at", defaultWidth: 145, minWidth: 120, maxWidth: 220 }
];
const columnWidthsKey = "modelbase.assetTable.columnWidths.v1";
const supportedModelFile = (filename: string, dxfUploadEnabled: boolean) =>
  (dxfUploadEnabled ? /\.(step|stp|glb|gltf|dxf)$/i : /\.(step|stp|glb|gltf)$/i).test(filename);
const validSortKeys = new Set<SortBy>(["name", "project", "status", "glb_size_bytes", "created_at"]);

function initialAdminState() {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get("view");
  const projectId = Number(params.get("projectId"));
  const view: View = kind === "projects" || kind === "unsorted" || kind === "trash" ? { kind }
    : kind === "project" && Number.isInteger(projectId) && projectId > 0 ? { kind: "project", id: projectId } : { kind: "all" };
  const requestedSort = params.get("sort");
  return { view, query: params.get("q") ?? "", sortBy: requestedSort && validSortKeys.has(requestedSort as SortBy) ? requestedSort as SortBy : "created_at" as SortBy, sortDir: params.get("dir") === "asc" ? "asc" as const : "desc" as const };
}

function adminPath(view: View, query: string, sortBy: SortBy, sortDir: "asc" | "desc") {
  const params = new URLSearchParams();
  if (view.kind !== "all") params.set("view", view.kind);
  if (view.kind === "project") params.set("projectId", String(view.id));
  if (query.trim()) params.set("q", query.trim());
  if (sortBy !== "created_at") params.set("sort", sortBy);
  if (sortDir !== "desc") params.set("dir", sortDir);
  return `/admin${params.size ? `?${params}` : ""}`;
}

function viewerPath(slug: string, returnTo: string) { return `/3dviewer/${encodeURIComponent(slug)}?returnTo=${encodeURIComponent(returnTo)}`; }

export function AdminPage({ theme, toggleTheme }: { theme: "dark" | "light"; toggleTheme: () => void }) {
  const initial = useMemo(initialAdminState, []);
  const [view, setView] = useState<View>(initial.view);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [query, setQuery] = useState(initial.query);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>(initial.sortBy);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initial.sortDir);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadInFlight, setUploadInFlight] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteForeverOpen, setDeleteForeverOpen] = useState(false);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState<number | null>(null);
  const [uploadHint, setUploadHint] = useState<string | null>(null);
  const [dxfUploadEnabled, setDxfUploadEnabled] = useState(false);
  const [revisionDialog, setRevisionDialog] = useState<{ kind: "new" | "replace" | "manage" | "share"; model: ModelRecord; revisionId?: number } | null>(null);
  const [dragState, setDragState] = useState<{ active: boolean; projectId: number | null; label: string; blocked: boolean }>({ active: false, projectId: null, label: "Unsorted", blocked: false });
  const [me, setMe] = useState<MeResponse | null>(null);
  const polling = useRef<number | undefined>(undefined);
  const dragDepth = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => { void getMe().then(setMe); }, []);

  const project = view.kind === "project" ? projects.find((item) => item.id === view.id) : undefined;
  const title = view.kind === "all" ? "All models" : view.kind === "projects" ? "Projects" :
    view.kind === "unsorted" ? "Unsorted" : view.kind === "trash" ? "Recycling bin" : project?.name ?? "Project";

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  const returnTo = useMemo(() => adminPath(view, query, sortBy, sortDir), [view, query, sortBy, sortDir]);
  useEffect(() => { window.history.replaceState(null, "", returnTo); }, [returnTo]);

  const refresh = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const modelParams: ModelListParams = { q: debouncedQuery || undefined, sortBy, sortDir };
      if (view.kind === "unsorted") modelParams.view = "unsorted";
      if (view.kind === "trash") modelParams.view = "recycling";
      if (view.kind === "project") modelParams.projectId = view.id;
      const [nextProjects, nextQuota, nextModels] = await Promise.all([
        listProjects(), getStorageQuota(), view.kind === "projects" ? Promise.resolve([]) : listLibraryModels(modelParams)
      ]);
      setProjects(nextProjects);
      setQuota(nextQuota);
      setModels(nextModels);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not refresh the asset library.");
    } finally { setLoading(false); }
  };

  useEffect(() => { setSelected(new Set()); void refresh(true); }, [view, debouncedQuery, sortBy, sortDir]);
  useEffect(() => { void getAppConfig().then(config => setDxfUploadEnabled(config.features.dxfUploadEnabled)).catch(() => setDxfUploadEnabled(false)); }, []);
  useEffect(() => {
    window.clearTimeout(polling.current);
    polling.current = window.setTimeout(() => void refresh(false), models.some((m) => activeStatuses.has(m.status.split("|")[1] ?? m.status)) ? 3000 : 15000);
    return () => window.clearTimeout(polling.current);
  }, [models, view, debouncedQuery, sortBy, sortDir]);

  const searchedProjects = useMemo(() => {
    const needle = debouncedQuery.toLowerCase();
    return needle ? projects.filter((item) => item.name.toLowerCase().includes(needle)) : projects;
  }, [projects, debouncedQuery]);

  const selectView = (next: View) => { setView(next); setQuery(""); setNotice(null); };
  const runBatch = async (action: BatchAction, projectId?: number | null, slugs = [...selected]) => {
    if(action==="trash"&&models.some(model=>slugs.includes(model.slug)&&["processing","cancelling"].includes(model.status.split("|")[1]??model.status))&&!window.confirm("This model is still converting. Moving it to the recycling bin will cancel the conversion."))return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await batchModels(action, slugs, projectId);
      setNotice(result.failed.length
        ? `${result.updated.length} updated. ${result.failed.map((item) => `${item.slug}: ${item.reason}`).join("; ")}`
        : `${result.updated.length} item${result.updated.length === 1 ? "" : "s"} updated.`);
      setSelected(new Set()); setMoveOpen(false); setDeleteForeverOpen(false); await refresh(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Batch action failed."); }
    finally { setBusy(false); }
  };
  const rowAction = (model: ModelRecord, action: BatchAction) => {
    setSelected(new Set([model.slug]));
    if (action === "moveToProject") setMoveOpen(true);
    else if (action === "deleteForever") setDeleteForeverOpen(true);
    else window.setTimeout(() => void runBatch(action, undefined, [model.slug]), 0);
  };

  const defaultDropTarget = () => {
    if (view.kind === "trash") return { projectId: null, label: "Recycling bin", blocked: true };
    if (view.kind === "project") return { projectId: view.id, label: project?.name ?? "Project", blocked: false };
    return { projectId: null, label: "Unsorted", blocked: false };
  };
  const dropTargetFromEvent = (event: React.DragEvent) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drop-project-id]") : null;
    if (element) {
      const projectId = Number(element.dataset.dropProjectId);
      const target = projects.find((item) => item.id === projectId);
      if (target) return { projectId, label: target.name, blocked: false };
    }
    return defaultDropTarget();
  };
  const isFileDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const openUpload = (file: File | null = null, projectId = view.kind === "project" ? view.id : null, hint: string | null = null) => {
    if (view.kind === "trash") {
      setError("Choose a project or All Models to upload.");
      return;
    }
    if (!uploadInFlight) { setStagedFile(file); setUploadProjectId(projectId); setUploadHint(hint); }
    setUploadOpen(true); setError(null);
  };
  const onDragEnter = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); dragDepth.current += 1;
    const target = dropTargetFromEvent(event);
    setDragState({ active: true, ...target });
  };
  const onDragOver = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = dragState.blocked ? "none" : "copy";
    const target = dropTargetFromEvent(event);
    setDragState((current) => current.projectId === target.projectId && current.blocked === target.blocked ? current : { active: true, ...target });
  };
  const onDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragState((current) => ({ ...current, active: false }));
  };
  const onDrop = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); dragDepth.current = 0;
    const target = dropTargetFromEvent(event);
    setDragState({ active: false, ...target });
    if (target.blocked) { setError("Choose a project or All Models to upload."); return; }
    const files = Array.from(event.dataTransfer.files);
    const file = files[0];
    if (!file || !supportedModelFile(file.name, dxfUploadEnabled)) {
      setError(`That file type is not supported. Choose a STEP, STP, GLB, or GLTF file${dxfUploadEnabled ? ", or a DXF file" : ""}.`);
      return;
    }
    openUpload(file, target.projectId, files.length > 1 ? `Only ${file.name} was staged; ${files.length - 1} additional file${files.length === 2 ? " was" : "s were"} ignored.` : null);
  };

  return <div className={`library-shell ${dragState.active ? "is-file-dragging" : ""}`} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <header className="library-header">
      <div className="brand"><span className="brand-mark"><Box size={20}/></span><strong>ModelBase</strong></div>
      <label className="global-search"><Search size={18}/><input ref={searchInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${view.kind === "projects" ? "projects" : "models"}`} />{query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery(""); searchInput.current?.focus(); }}><X size={15}/></button>}</label>
      <button className="icon-button" onClick={toggleTheme} title="Toggle theme">{theme === "dark" ? <Sun size={17}/> : <Moon size={17}/>}</button>
      {me?.authenticated && <AccountMenu me={me} />}
      <button className="primary-button" onClick={() => openUpload()}><Upload size={16}/> Upload</button>
    </header>
    <div className="library-layout">
      <aside className="library-sidebar">
        <nav className="sidebar-nav">
          <SideItem active={view.kind === "all"} icon={<HardDrive/>} label="All models" onClick={() => selectView({kind:"all"})}/>
          <SideItem active={view.kind === "projects" || view.kind === "project"} icon={<Folder/>} label="Projects" onClick={() => selectView({kind:"projects"})}/>
          <SideItem active={view.kind === "unsorted"} icon={<ArchiveRestore/>} label="Unsorted" onClick={() => selectView({kind:"unsorted"})}/>
        </nav>
        <div className="sidebar-bottom">
          <SideItem active={view.kind === "trash"} icon={<Trash2/>} label="Recycling bin" onClick={() => selectView({kind:"trash"})}/>
          <QuotaCard quota={quota}/>
        </div>
      </aside>
      <main className="library-main">
        <div className="library-heading">
          <div>{view.kind === "project" && <div className="breadcrumbs"><button onClick={() => selectView({kind:"projects"})}>Projects</button><ChevronRight size={14}/></div>}
            <h1>{title}</h1>{view.kind === "trash" && <p>Items in the recycling bin still count toward storage.</p>}</div>
          <div className="heading-actions">{selected.size > 0
            ? <BatchToolbar trash={view.kind === "trash"} count={selected.size} busy={busy} onClear={() => setSelected(new Set())} onMove={() => setMoveOpen(true)} onTrash={() => void runBatch("trash")} onRestore={() => void runBatch("restore")} onDelete={() => setDeleteForeverOpen(true)}/>
            : <>{view.kind === "projects" && <button className="secondary-button" onClick={async () => { const name=window.prompt("Project name"); if(name){await createProject(name); await refresh();}}}><Plus size={16}/> New project</button>}
              <button className="icon-button" onClick={() => refresh(true)} title="Refresh"><RefreshCw className={loading ? "animate-spin" : ""} size={17}/></button></>}</div>
        </div>
        {error && <div className="alert error">{error}</div>}{notice && <div className="alert"><Check size={16}/>{notice}</div>}
        <section className={`asset-surface ${view.kind === "projects" ? "projects-surface" : ""}`}>
          {view.kind === "projects" ? <ProjectList projects={searchedProjects} dragProjectId={dragState.active ? dragState.projectId : null} onOpen={(id)=>selectView({kind:"project",id})} onRefresh={()=>refresh()} /> :
            <AssetTable models={models} uploadTasks={uploadTasks.filter(task => view.kind === "all" || (view.kind === "unsorted" && task.projectId === null) || (view.kind === "project" && task.projectId === view.id))} loading={loading} trash={view.kind === "trash"} selected={selected} sortBy={sortBy} sortDir={sortDir} returnTo={returnTo}
              emptyTitle={view.kind === "project" ? `${title} is empty.` : view.kind === "unsorted" ? "No unsorted models." : "No models yet."}
              emptyDescription={view.kind === "project" ? "Drop STEP or GLB files here." : view.kind === "unsorted" ? "Models without a project will appear here." : "Drop STEP or GLB files here to get started."}
              onSort={(key)=>{if(sortBy===key)setSortDir(d=>d==="asc"?"desc":"asc");else{setSortBy(key);setSortDir("asc");}}}
              onSelected={setSelected} onAction={rowAction} onRevisionAction={(kind,model,revisionId)=>setRevisionDialog({kind,model,revisionId})} onRefresh={()=>refresh(false)}/>}
        </section>
      </main>
    </div>
    {dragState.active && <DropUploadOverlay label={dragState.label} blocked={dragState.blocked}/>}
    {(uploadOpen || uploadInFlight) && <UploadDialog visible={uploadOpen} dxfUploadEnabled={dxfUploadEnabled} projects={projects} defaultProjectId={uploadProjectId} initialFile={stagedFile} hint={uploadHint} onClose={()=>setUploadOpen(false)} onBusyChange={setUploadInFlight} onTask={(task)=>{setUploadTasks(current=>{const exists=current.some(item=>item.clientUploadId===task.clientUploadId);return exists?current.map(item=>item.clientUploadId===task.clientUploadId?task:item):[task,...current]});if(task.stage==="queued")window.setTimeout(()=>setUploadTasks(current=>current.filter(item=>item.clientUploadId!==task.clientUploadId)),2000)}} onDone={async()=>{setUploadOpen(false);setUploadInFlight(false);setStagedFile(null);setUploadHint(null);await refresh();}}/>}
    {moveOpen && <MoveDialog projects={projects} busy={busy} onClose={()=>setMoveOpen(false)} onMove={(id)=>void runBatch("moveToProject",id)}/>}
    {deleteForeverOpen && <ConfirmDialog count={selected.size} busy={busy} onClose={()=>setDeleteForeverOpen(false)} onConfirm={()=>void runBatch("deleteForever")}/>}
    {revisionDialog?.kind === "new" && <UploadRevisionDialog model={revisionDialog.model} dxfUploadEnabled={dxfUploadEnabled} onClose={()=>setRevisionDialog(null)} onDone={async(message)=>{setRevisionDialog(null);setNotice(message);await refresh(false)}}/>}
    {revisionDialog?.kind === "replace" && <ReplaceRevisionDialog model={revisionDialog.model} dxfUploadEnabled={dxfUploadEnabled} initialRevisionId={revisionDialog.revisionId} onClose={()=>setRevisionDialog(null)} onDone={async(message)=>{setRevisionDialog(null);setNotice(message);await refresh(false)}}/>}
    {revisionDialog?.kind === "manage" && <ManageRevisionsDialog model={revisionDialog.model} onClose={()=>setRevisionDialog(null)} onReplace={(revisionId)=>setRevisionDialog({kind:"replace",model:revisionDialog.model,revisionId})} onChanged={async()=>refresh(false)}/>}
    {revisionDialog?.kind === "share" && <ShareSettingsDialog model={revisionDialog.model} onClose={()=>setRevisionDialog(null)}/>}
  </div>;
}

function AccountMenu({ me }: { me: Extract<MeResponse, { authenticated: true }> }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [busy, setBusy] = useState(false);
  const menuWidth = 220;

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const height = menuRef.current?.offsetHeight ?? 110;
      const gap = 5;
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth)),
        top: rect.bottom + gap + height <= window.innerHeight - 8 ? rect.bottom + gap : Math.max(8, rect.top - height - gap)
      });
    };
    place();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const label = me.user.displayName || me.user.email;
  const initials = label.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("") || "?";

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    await postLogout();
  };

  const menu = open ? createPortal(
    <div ref={menuRef} className="menu-popover account-popover" style={position}>
      <div className="account-popover-user">
        <strong>{label}</strong>
        {me.user.displayName && <span>{me.user.email}</span>}
        {me.organization && <span className="account-popover-org">{me.organization.name}</span>}
      </div>
      <button onClick={handleSignOut} disabled={busy}><LogOut size={15}/>{busy ? "Signing out…" : "Sign out"}</button>
    </div>,
    document.body
  ) : null;

  return (
    <div className="account-menu">
      <button ref={buttonRef} className="account-avatar" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Account menu" title={label}>{initials}</button>
      {menu}
    </div>
  );
}

function SideItem({active,icon,label,onClick}:{active:boolean;icon:React.ReactElement<{size?:number}>;label:string;onClick:()=>void}) {
  return <button className={`side-item ${active?"active":""}`} onClick={onClick}>{React.cloneElement(icon,{size:18})}<span>{label}</span></button>;
}

function QuotaCard({quota}:{quota:StorageQuota|null}) {
  const pct=Math.min(100,quota?.percentUsed??0); const tone=pct>=90?"danger":pct>=75?"warning":"normal";
  return <div className="quota-card"><div className="quota-title"><HardDrive size={16}/><strong>Storage</strong></div>
    <div className="quota-copy">{quota ? `${formatBytes(quota.usedBytes)} of ${formatBytes(quota.quotaBytes)} used` : "Loading storage…"}</div>
    <div className="quota-track"><span className={tone} style={{width:`${pct}%`}}/></div>
    <div className="quota-available">{quota ? `${formatBytes(quota.availableBytes)} available` : ""}</div></div>;
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return "Not recorded";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatMB(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "Not recorded";
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatPercent(fraction?: number): string {
  if (fraction === undefined || fraction === null) return "Not recorded";
  return `${Math.round(fraction * 100)}%`;
}

function formatSwap(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "Not recorded";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function formatReduction(reductionPercent?: number): string {
  if (reductionPercent === undefined || reductionPercent === null) return "Not recorded";
  return `${reductionPercent}%`;
}

function ModelDetailsPanel({ summary }: { summary?: any }) {
  if (!summary) {
    return <div className="model-details-empty">No conversion details available.</div>;
  }

  const {
    mode,
    status,
    skipReason,
    decisionReasons,
    targetChunks,
    actualChunks,
    maxActiveChunks,
    plannerDurationSeconds,
    totalWallClockSeconds,
    rawGlbBytes,
    finalGlbBytes,
    meshoptReductionPercent,
    peakMemoryFraction,
    swapGrowthBytes,
    chunks,
    fallbackReason,
    processingProgress
  } = summary;

  return (
    <div className="model-details-panel" onClick={(e) => e.stopPropagation()}>
      <div className="details-grid">
        <div className="details-section">
          <h4>Chunking Configuration</h4>
          <div className="details-row-item">
            <span className="details-label">Mode:</span>
            <span className="details-val">{mode ?? "Not recorded"}</span>
          </div>
          <div className="details-row-item">
            <span className="details-label">Status:</span>
            <span className="details-val">{status ?? "Not recorded"}</span>
          </div>
          {skipReason && (
            <div className="details-row-item">
              <span className="details-label">Skip Reason:</span>
              <span className="details-val">{skipReason}</span>
            </div>
          )}
          {fallbackReason && (
            <div className="details-row-item">
              <span className="details-label">Failure/Fallback:</span>
              <span className="details-val danger-text">{fallbackReason}</span>
            </div>
          )}
          {processingProgress && (
            <div className="details-row-item">
              <span className="details-label">Progress:</span>
              <span className="details-val highlight-text">{processingProgress}</span>
            </div>
          )}
        </div>

        <div className="details-section">
          <h4>Execution & Timing</h4>
          <div className="details-row-item">
            <span className="details-label">Total Time:</span>
            <span className="details-val">{formatDuration(totalWallClockSeconds)}</span>
          </div>
          {plannerDurationSeconds !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Planner Time:</span>
              <span className="details-val">{formatDuration(plannerDurationSeconds)}</span>
            </div>
          )}
          {targetChunks !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Target Chunks:</span>
              <span className="details-val">{targetChunks}</span>
            </div>
          )}
          {actualChunks !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Actual Chunks:</span>
              <span className="details-val">{actualChunks}</span>
            </div>
          )}
          {maxActiveChunks !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Max Active:</span>
              <span className="details-val">{maxActiveChunks}</span>
            </div>
          )}
        </div>

        <div className="details-section">
          <h4>Optimization & Size</h4>
          {rawGlbBytes !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Raw GLB Size:</span>
              <span className="details-val">{formatMB(rawGlbBytes)}</span>
            </div>
          )}
          {finalGlbBytes !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Final GLB Size:</span>
              <span className="details-val">{formatMB(finalGlbBytes)}</span>
            </div>
          )}
          {meshoptReductionPercent !== undefined && meshoptReductionPercent !== null && (
            <div className="details-row-item">
              <span className="details-label">Meshopt Reduction:</span>
              <span className="details-val">{formatReduction(meshoptReductionPercent)}</span>
            </div>
          )}
        </div>

        <div className="details-section">
          <h4>Resources & Memory</h4>
          {peakMemoryFraction !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Peak Memory:</span>
              <span className="details-val">{formatPercent(peakMemoryFraction)}</span>
            </div>
          )}
          {swapGrowthBytes !== undefined && (
            <div className="details-row-item">
              <span className="details-label">Swap Growth:</span>
              <span className="details-val">{formatSwap(swapGrowthBytes)}</span>
            </div>
          )}
        </div>
      </div>

      {decisionReasons && decisionReasons.length > 0 && (
        <div className="details-full-width">
          <h5>Decision Reasons</h5>
          <ul className="reasons-list">
            {decisionReasons.map((r: string, idx: number) => (
              <li key={idx}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {chunks && chunks.length > 0 && (
        <div className="details-full-width">
          <h5>Per-Chunk Durations</h5>
          <div className="chunks-grid">
            {chunks.map((c: any) => (
              <div key={c.index} className="chunk-info-card">
                <strong>Chunk {c.index + 1}</strong>
                <span>Time: {formatDuration(c.durationSeconds)}</span>
                {c.triangles !== undefined && (
                  <span>Faces: {c.triangles.toLocaleString()}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AssetTable({models,uploadTasks,loading,trash,selected,sortBy,sortDir,returnTo,emptyTitle,emptyDescription,onSort,onSelected,onAction,onRevisionAction,onRefresh}:{models:ModelRecord[];uploadTasks:UploadTask[];loading:boolean;trash:boolean;selected:Set<string>;sortBy:SortBy;sortDir:"asc"|"desc";returnTo:string;emptyTitle:string;emptyDescription:string;onSort:(k:SortBy)=>void;onSelected:(s:Set<string>)=>void;onAction:(m:ModelRecord,a:BatchAction)=>void;onRevisionAction:(kind:"new"|"replace"|"manage"|"share",model:ModelRecord,revisionId?:number)=>void;onRefresh:()=>void}) {
  models=[...uploadTasks.map(task=>({id:-1,slug:`upload-${task.clientUploadId}`,name:task.filename.replace(/\.[^.]+$/,"") ,source_filename:task.filename,source_ext:"",status:`upload:${task.stage}:${task.percent}:${task.currentChunk}:${task.totalChunks}`,has_display_glb:0,glb_size_bytes:null,original_size_bytes:task.sizeBytes,folder_id:task.projectId,project_id:task.projectId,project_name:task.projectName,quality:task.quality,deleted_at:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()} as ModelRecord)),...models];
  const rangeAnchor = useRef<string | null>(null);
  const [widths,setWidths]=useState<Record<ColumnKey,number>>(()=>{
    const defaults=Object.fromEntries(columnDefinitions.map(column=>[column.key,column.defaultWidth])) as Record<ColumnKey,number>;
    try { const saved=JSON.parse(localStorage.getItem(columnWidthsKey)??"{}"); return Object.fromEntries(columnDefinitions.map(column=>{const value=saved[column.key];return [column.key,typeof value==="number"&&Number.isFinite(value)?Math.min(column.maxWidth,Math.max(column.minWidth,value)):defaults[column.key]]})) as Record<ColumnKey,number>; } catch{return defaults}
  });
  const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(new Set());
  const toggleExpand = (slug: string) => {
    const next = new Set(expandedSlugs);
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    setExpandedSlugs(next);
  };
  const selectableModels=models.filter(model=>!model.status.startsWith("upload:"));
  const all=selectableModels.length>0&&selectableModels.every(m=>selected.has(m.slug));
  const toggle=(slug:string,shiftKey:boolean)=>{const next=new Set(selected);const shouldSelect=!next.has(slug);const anchorIndex=rangeAnchor.current?models.findIndex(model=>model.slug===rangeAnchor.current):-1;const targetIndex=models.findIndex(model=>model.slug===slug);if(shiftKey&&anchorIndex>=0&&targetIndex>=0){models.slice(Math.min(anchorIndex,targetIndex),Math.max(anchorIndex,targetIndex)+1).forEach(model=>shouldSelect?next.add(model.slug):next.delete(model.slug));}else{shouldSelect?next.add(slug):next.delete(slug);}rangeAnchor.current=slug;onSelected(next)};
  if(loading&&!models.length)return <div className="empty-state"><Loader2 className="animate-spin"/><strong>Loading assets…</strong></div>;
  if(!models.length)return <div className="empty-state"><Box/><strong>{trash?"Recycling bin is empty.":emptyTitle}</strong><span>{trash?"Deleted models will appear here.":emptyDescription}</span></div>;
  const tableWidth=104+columnDefinitions.reduce((total,column)=>total+widths[column.key],0);
  const resize=(key:ColumnKey,width:number)=>{const next={...widths,[key]:width};setWidths(next);localStorage.setItem(columnWidthsKey,JSON.stringify(next))};
  return <div className="table-scroll"><table className="asset-table" style={{width:tableWidth,minWidth:"100%"}}><thead><tr><th className="check-cell"><input type="checkbox" checked={all} onChange={()=>onSelected(all?new Set():new Set(selectableModels.map(m=>m.slug)))} aria-label="Select all visible"/></th>
    {columnDefinitions.map(column=><ResizableHeaderCell key={column.key} width={widths[column.key]} minWidth={column.minWidth} maxWidth={column.maxWidth} onResize={(width)=>resize(column.key,width)}>{column.sortKey?<button className="sort-button" onClick={()=>onSort(column.sortKey!)}>{column.label}{sortBy===column.sortKey&&(sortDir==="asc"?<ArrowUp/>:<ArrowDown/>)}</button>:<span>{column.label}</span>}</ResizableHeaderCell>)}<th className="action-cell">Actions</th></tr></thead>
    <tbody>{models.map(model=>{
      const isUpload=model.status.startsWith("upload:");
      const hasSummary = !!model.largeStepChunkingSummary;
      const isExpanded = expandedSlugs.has(model.slug);
      const open=()=>{if(!isUpload)window.location.href=viewerPath(model.slug,returnTo)};
      return <React.Fragment key={model.slug}>
        <tr className={`${selected.has(model.slug)?"selected ":""}${trash||isUpload?"":"clickable-row"}`} tabIndex={trash||isUpload?undefined:0} role={trash||isUpload?undefined:"link"} onClick={event=>{if(!trash&&!isUpload&&!(event.target as Element).closest("a,button,input,select,textarea"))open()}} onKeyDown={event=>{if(!trash&&!isUpload&&event.key==="Enter"&&!(event.target as Element).closest("a,button,input,select,textarea"))open()}}>
          <td className="check-cell">{!isUpload&&<input type="checkbox" checked={selected.has(model.slug)} onChange={event=>toggle(model.slug,(event.nativeEvent as MouseEvent).shiftKey)} aria-label={`Select ${model.name}`}/>}</td>
          <td>
            <div style={{ display: "flex", alignItems: "center" }}>
              {!trash && !isUpload && (
                hasSummary ? (
                  <button className="expand-button" onClick={(e) => { e.stopPropagation(); toggleExpand(model.slug); }} title="Toggle details">
                    <ChevronRight className={`expand-icon ${isExpanded ? 'rotated' : ''}`} />
                  </button>
                ) : (
                  <div style={{ width: "24px", flexShrink: 0 }} />
                )
              )}
              {trash||isUpload?<div className="model-name"><span className="file-icon">{isUpload?<Upload size={17}/>:<Box size={17}/>}</span><span><strong>{model.name}</strong><small>{model.source_filename}</small></span></div>:<a className="model-name" href={viewerPath(model.slug,returnTo)}><span className="file-icon"><Box size={17}/></span><span><strong>{model.name}</strong><small>{model.source_filename}</small></span></a>}
            </div>
          </td>
          <td>{model.project_name??<span className="muted">Unsorted</span>}</td>
          <td className="revision-cell">{isUpload ? <span className="muted">Rev —</span> : model.current_revision_label ? `Rev ${model.current_revision_label}` : <span className="muted">Legacy</span>}</td>
          <td>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <Status status={model.status}/>
              {model.largeStepChunkingSummary?.label && (
                <span className="chunking-badge-text">
                  {model.largeStepChunkingSummary.label}
                  {model.largeStepChunkingSummary.detailLabel ? ` — ${model.largeStepChunkingSummary.detailLabel}` : ""}
                </span>
              )}
            </div>
          </td>
          <td className="quality-cell">{model.quality??"—"}</td>
          <td>{formatFileSize(model.glb_size_bytes)}</td>
          <td>{formatDate(model.created_at)}</td>
          <td className="action-cell">{!isUpload&&<RowMenu model={model} trash={trash} returnTo={returnTo} onAction={onAction} onRevisionAction={onRevisionAction} onRefresh={onRefresh}/>}</td>
        </tr>
        {isExpanded && !isUpload && (
          <tr className="details-row">
            <td />
            <td colSpan={8}>
              <ModelDetailsPanel summary={model.largeStepChunkingSummary} />
            </td>
          </tr>
        )}
      </React.Fragment>
    })}</tbody></table></div>;
}

function Status({status}:{status:string}){if(status.startsWith("upload:")){const[,stage,percent,current,total]=status.split(":");return <div className={`row-progress ${stage==="failed"||stage==="cancelled"?"failed":""}`}><strong>{stage==="uploading"?`Uploading ${percent}%`:stage[0].toUpperCase()+stage.slice(1)}</strong>{Number(total)>0&&stage==="uploading"&&<small>chunk {current} of {total}</small>}<span><i style={{width:`${percent}%`}}/></span></div>}if(status.startsWith("progress|")){const[,stage,percent,label,started]=status.split("|");const minutes=started?Math.floor(Math.max(0,Date.now()-new Date(`${started}Z`).getTime())/60000):0;return <div className="row-progress"><strong>{label} - {percent}%</strong><small>{minutes?`${minutes}m elapsed`:stage==="cancelling"?"Stopping worker process":"Stage-based progress"}</small><span><i style={{width:`${percent}%`}}/></span></div>}return <span className={`compact-status ${statusKind(status)}`}><span/>{statusLabel(status)}</span>}

function RowMenu({model,trash,returnTo,onAction,onRevisionAction,onRefresh}:{model:ModelRecord;trash:boolean;returnTo:string;onAction:(m:ModelRecord,a:BatchAction)=>void;onRevisionAction:(kind:"new"|"replace"|"manage"|"share",model:ModelRecord,revisionId?:number)=>void;onRefresh:()=>void}) {
  const [open,setOpen]=useState(false);
  const buttonRef=useRef<HTMLButtonElement>(null); const menuRef=useRef<HTMLDivElement>(null); const [position,setPosition]=useState({top:0,left:0});
  useEffect(()=>{if(!open)return;const place=()=>{const button=buttonRef.current;if(!button)return;const rect=button.getBoundingClientRect();const width=230;const height=menuRef.current?.offsetHeight??(trash?126:460);const gap=5;setPosition({left:Math.max(8,Math.min(window.innerWidth-width-8,rect.right-width)),top:rect.bottom+gap+height<=window.innerHeight-8?rect.bottom+gap:Math.max(8,rect.top-height-gap)});};place();const close=(event:PointerEvent)=>{const target=event.target as Node;if(!buttonRef.current?.contains(target)&&!menuRef.current?.contains(target))setOpen(false)};const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false)};window.addEventListener("resize",place);window.addEventListener("scroll",place,true);document.addEventListener("pointerdown",close);document.addEventListener("keydown",escape);return()=>{window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape)}},[open,trash]);
  const menu=open?createPortal(<div ref={menuRef} className="menu-popover" style={position} onClick={event=>{if((event.target as Element).closest("a"))setOpen(false)}}>
    {!trash&&<><a href={viewerPath(model.slug,returnTo)}><Box/>Open viewer</a>
      <button onClick={()=>{onRevisionAction("share",model);setOpen(false)}}><Share2/>Share link and QR</button>
      <a href={`/downloads/${encodeURIComponent(model.slug)}/original`}><Download/>Download original</a>
      <a href={`/downloads/${encodeURIComponent(model.slug)}/display.glb`}><Download/>Download GLB</a>
      <button onClick={()=>{onRevisionAction("new",model);setOpen(false)}}><Upload/>Upload new revision</button>
      <button onClick={()=>{onRevisionAction("replace",model);setOpen(false)}}><Replace/>Replace existing revision</button>
      <button onClick={()=>{onRevisionAction("manage",model);setOpen(false)}}><History/>Manage revisions</button>
      <button onClick={async()=>{const name=window.prompt("Model name",model.name);if(name&&name!==model.name){await renameModel(model.slug,name);onRefresh()}setOpen(false)}}><Pencil/>Rename</button>
      <button onClick={()=>{onAction(model,"moveToProject");setOpen(false)}}><FolderOpen/>Move to project</button><a href={`/admin/logs/${encodeURIComponent(model.slug)}/conversion.log`}><List/>Log</a><button className="danger-item" onClick={()=>{onAction(model,"trash");setOpen(false)}}><Trash2/>Move to recycling bin</button></>}
    {trash&&<><button onClick={()=>{onAction(model,"restore");setOpen(false)}}><ArchiveRestore/>Restore</button><button className="danger-item" onClick={()=>{onAction(model,"deleteForever");setOpen(false)}}><Trash2/>Delete forever</button></>}
  </div>,document.body):null;
  return <div className="row-menu"><button ref={buttonRef} className="menu-button" onClick={()=>setOpen(!open)} aria-expanded={open} aria-label={`Actions for ${model.name}`}><MoreVertical size={17}/></button>{menu}</div>;
}

function ProjectList({projects,dragProjectId,onOpen,onRefresh}:{projects:ProjectRecord[];dragProjectId:number|null;onOpen:(id:number)=>void;onRefresh:()=>void}) {
  if(!projects.length)return <div className="empty-state"><Folder/><strong>No projects yet.</strong><span>Create a project to organise your models.</span></div>;
  return <div className="project-list">{projects.map(p=><div className={`project-row clickable-row ${dragProjectId===p.id?"drop-target":""}`} data-drop-project-id={p.id} key={p.id} role="link" tabIndex={0} onClick={event=>{if(!(event.target as Element).closest("button,a,input"))onOpen(p.id)}} onKeyDown={event=>{if(event.key==="Enter"&&!(event.target as Element).closest("button,a,input"))onOpen(p.id)}}><button className="project-open" onClick={()=>onOpen(p.id)}><span className="project-folder"><Folder size={20}/></span><span><strong>{p.name}</strong><small>{p.model_count} model{p.model_count===1?"":"s"}</small></span></button><span>{formatBytes(p.total_size_bytes)}</span><span>Updated {formatDate(p.updated_at)}</span><div className="project-actions"><button className="icon-button" title="Rename" onClick={async()=>{const name=window.prompt("Project name",p.name);if(name&&name!==p.name){await renameProject(p.id,name);onRefresh()}}}><Pencil size={15}/></button><button className="icon-button" title={p.model_count?"Move all models out before deleting":"Delete empty project"} disabled={p.model_count>0} onClick={async()=>{if(window.confirm(`Delete empty project “${p.name}”?`)){await deleteProject(p.id);onRefresh()}}}><Trash2 size={15}/></button></div></div>)}</div>;
}

function BatchToolbar({trash,count,busy,onClear,onMove,onTrash,onRestore,onDelete}:{trash:boolean;count:number;busy:boolean;onClear:()=>void;onMove:()=>void;onTrash:()=>void;onRestore:()=>void;onDelete:()=>void}){return <div className="batch-toolbar"><strong>{count} selected</strong>{trash?<><button onClick={onRestore} disabled={busy}><ArchiveRestore/>Restore</button><button className="danger-action" onClick={onDelete} disabled={busy}><Trash2/>Delete forever</button></>:<><button onClick={onMove} disabled={busy}><FolderOpen/>Move to project</button><button onClick={onTrash} disabled={busy}><Trash2/>Move to recycling bin</button></>}<button className="batch-close" onClick={onClear} title="Clear selection"><X/></button></div>}

async function copyText(value:string){
  if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return}
  const input=document.createElement("textarea");input.value=value;input.style.position="fixed";input.style.opacity="0";document.body.appendChild(input);input.select();document.execCommand("copy");input.remove();
}

function DropUploadOverlay({label,blocked}:{label:string;blocked:boolean}){return <div className={`drop-upload-overlay ${blocked?"blocked":""}`}><div><Upload/><strong>{blocked?"Uploads aren't available here":"Drop to upload"}</strong><span>{blocked?"Choose a project or All Models to upload.":`to ${label}`}</span></div></div>}
function UploadDialog({
  visible,
  dxfUploadEnabled,
  projects,
  defaultProjectId,
  initialFile,
  hint,
  onClose,
  onBusyChange,
  onTask,
  onDone
}: {
  visible: boolean;
  dxfUploadEnabled: boolean;
  projects: ProjectRecord[];
  defaultProjectId: number | null;
  initialFile: File | null;
  hint: string | null;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onTask: (task: UploadTask) => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(initialFile);
  const [projectId, setProjectId] = useState(defaultProjectId ? String(defaultProjectId) : "");
  const [quality, setQuality] = useState<ConversionQuality>("medium");
  const [meshiqAdaptiveSmoothing, setMeshiqAdaptiveSmoothing] = useState<MeshiqAdaptiveSmoothing>("off");
  const [revisionLabel, setRevisionLabel] = useState("");
  const [issuedDate, setIssuedDate] = useState(todayLocal());
  const [allowPublicSelectable, setAllowPublicSelectable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ percent: number; text: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadIdRef = useRef<string | null>(null);
  const taskRef = useRef<UploadTask | null>(null);
  const updateTask = (changes: Partial<UploadTask>) => { if (!taskRef.current) return; taskRef.current={...taskRef.current,...changes}; onTask(taskRef.current); };

  async function handleCancel() {
    if (busy) {
      abortControllerRef.current?.abort();
      setError("Upload cancelled.");
      setBusy(false);
      onBusyChange(false);
      updateTask({ stage: "cancelled", error: "Upload cancelled." });
      setProgress(null);
      if (uploadIdRef.current) {
        const uid = uploadIdRef.current;
        uploadIdRef.current = null;
        void deleteChunkedUpload(uid).catch((e) => {
          console.error("Failed to cleanup chunked upload:", e);
        });
      }
    } else {
      onClose();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setBusy(true);
    onBusyChange(true);
    setError(null);
    setProgress(null);
    abortControllerRef.current = new AbortController();

    const isStep = /\.(step|stp)$/i.test(file.name);
    const isGlb = /\.(glb|gltf)$/i.test(file.name);
    taskRef.current={clientUploadId:crypto.randomUUID(),uploadId:null,filename:file.name,sizeBytes:file.size,uploadedBytes:0,percent:0,currentChunk:0,totalChunks:0,stage:"initializing",projectId:projectId?Number(projectId):null,projectName:projects.find(p=>p.id===Number(projectId))?.name??null,quality,meshiqAdaptiveSmoothing};
    onTask(taskRef.current);

    if (isGlb && file.size > 262144000) {
      setError("GLB/GLTF files must be under 250 MB.");
      updateTask({ stage:"failed", error:"GLB/GLTF files must be under 250 MB." });
      setBusy(false);
      onBusyChange(false);
      return;
    }
    if (isStep && file.size > 524288000) {
      setError("STEP/STP files must be under 500 MB.");
      updateTask({ stage:"failed", error:"STEP/STP files must be under 500 MB." });
      setBusy(false);
      onBusyChange(false);
      return;
    }

    // Always use chunked upload for files over 80 MB
    const useChunked = file.size > 83886080;

    try {
      if (useChunked) {
        setProgress({ percent: 0, text: "Initializing upload..." });
        const { uploadId, chunkSizeBytes } = await initChunkedUpload(
          file.name,
          file.size,
          projectId ? Number(projectId) : null,
          quality,
          { revisionLabel, issuedDate, allowPublicSelectable },
          meshiqAdaptiveSmoothing
        );
        uploadIdRef.current = uploadId;

        const totalChunks = Math.ceil(file.size / chunkSizeBytes);
        updateTask({ uploadId, totalChunks, stage: "uploading" });

        for (let i = 0; i < totalChunks; i++) {
          if (abortControllerRef.current?.signal.aborted) {
            throw new DOMException("Upload cancelled.", "AbortError");
          }

          const start = i * chunkSizeBytes;
          const end = Math.min(start + chunkSizeBytes, file.size);
          const chunkBlob = file.slice(start, end);
          const percent = Math.floor((start / file.size) * 100);

          setProgress({
            percent,
            text: `Uploading chunk ${i + 1} of ${totalChunks} - ${formatBytes(start)} of ${formatBytes(file.size)} (${percent}%)`
          });
          updateTask({ stage:"uploading", uploadedBytes:start, percent, currentChunk:i+1, totalChunks });

          await uploadChunk(
            uploadId,
            i,
            totalChunks,
            chunkBlob,
            abortControllerRef.current.signal,
            (chunkUploaded) => {
              const uploaded = Math.min(start + chunkUploaded, file.size);
              const livePercent = Math.floor((uploaded / file.size) * 100);
              setProgress({
                percent: livePercent,
                text: `Uploading chunk ${i + 1} of ${totalChunks} - ${formatBytes(uploaded)} of ${formatBytes(file.size)} (${livePercent}%)`
              });
              updateTask({ uploadedBytes:uploaded, percent:livePercent, currentChunk:i+1 });
            }
          );
        }

        setProgress({ percent: 100, text: "Finalizing upload..." });
        updateTask({ stage:"finalizing", uploadedBytes:file.size, percent:100 });
        const model = await completeChunkedUpload(uploadId);
        uploadIdRef.current = null;
        setProgress({ percent: 100, text: model.status === "ready" ? "Upload complete - Ready" : "Upload complete - Queued for conversion" });
        updateTask({ stage:"queued", modelSlug:model.slug, percent:100 });
      } else {
        setProgress({ percent: 50, text: "Uploading file..." });
        updateTask({ stage:"uploading", percent:50, currentChunk:1, totalChunks:1 });
        const model=await uploadModel(
          file,
          projectId ? Number(projectId) : null,
          quality,
          abortControllerRef.current.signal,
          { revisionLabel, issuedDate, allowPublicSelectable },
          meshiqAdaptiveSmoothing
        );
        updateTask({ stage:"queued", modelSlug:model.slug, uploadedBytes:file.size, percent:100 });
      }

      onDone();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Upload cancelled.");
      } else {
        setError(err instanceof Error ? err.message : "Upload failed.");
      }
      setBusy(false);
      onBusyChange(false);
      updateTask({ stage: err instanceof Error && err.name === "AbortError" ? "cancelled" : "failed", error: err instanceof Error ? err.message : "Upload failed." });
      setProgress((current) => current ? { ...current, text: `Upload failed: ${err instanceof Error ? err.message : "Unknown error."}` } : null);
    } finally {
      abortControllerRef.current = null;
    }
  }

  if (!visible) return null;
  return (
    <Dialog title="Upload model" onClose={onClose}>
      <form onSubmit={handleSubmit} className="dialog-form">
        <label className={`upload-drop ${busy ? "disabled" : ""}`}>
          <Upload />
          <strong>{file?.name ?? "Choose a model file"}</strong>
          <span>
            {file
              ? `File staged (${(file.size / (1024 * 1024)).toFixed(1)} MB) — review below.`
              : `STEP/STP${dxfUploadEnabled ? "/DXF" : ""} up to 500 MB; GLB/GLTF up to 250 MB`}
          </span>
          <input
            type="file"
            accept={dxfUploadEnabled ? ".step,.stp,.glb,.gltf,.dxf" : ".step,.stp,.glb,.gltf"}
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {hint && <div className="upload-hint">{hint}</div>}
        {dxfUploadEnabled && <div className="upload-hint"><strong>DXF export guide</strong><p>Revit users: export DXF from a dedicated 3D view with Solids set to Polymesh and Colours set to By element/display colours. Avoid ACIS solids.</p></div>}
        <label>
          Project
          <select
            className="field"
            value={projectId}
            disabled={busy}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Unsorted</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="revision-fields">
          <label>Revision<input className="field" value={revisionLabel} disabled={busy} maxLength={100} onChange={e=>setRevisionLabel(e.target.value)} placeholder="Auto-numbered as Rev 1"/><small>Leave blank to auto-number.</small></label>
          <label>Date issued<input className="field" type="date" value={issuedDate} disabled={busy} onChange={e=>setIssuedDate(e.target.value)}/><small>Used for QR/share history and drawing issue tracking.</small></label>
        </div>
        <fieldset disabled={busy}>
          <legend>Quality</legend>
          <QualityOptions value={quality} onChange={setQuality}/>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Advanced / Experimental</legend>
          <MeshIqSmoothingOptions value={meshiqAdaptiveSmoothing} onChange={setMeshiqAdaptiveSmoothing}/>
          <p className="field-help">Experimental. Smooths large curved parts such as tanks and long tubes. Off is safest.</p>
        </fieldset>
        <label className="checkbox-field"><input type="checkbox" checked={allowPublicSelectable} disabled={busy} onChange={e=>setAllowPublicSelectable(e.target.checked)}/><span><strong>Allow public revision selection</strong><small>Available in the public revision dropdown when that viewer feature is enabled.</small></span></label>
        {progress && (
          <div className="upload-progress" role="status" aria-live="polite">
            <div className="upload-progress-heading"><strong>{progress.percent}%</strong><span>{progress.text}</span></div>
            <div className="upload-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
              <span style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}
        {error && <div className="alert error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={handleCancel}>
            {busy ? "Cancel Upload" : "Cancel"}
          </button>
          <button className="primary-button" disabled={!file || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            Upload
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function UploadRevisionDialog({model,dxfUploadEnabled,onClose,onDone}:{model:ModelRecord;dxfUploadEnabled:boolean;onClose:()=>void;onDone:(message:string)=>void}) {
  const [file,setFile]=useState<File|null>(null);
  const [revisionLabel,setRevisionLabel]=useState("");
  const [issuedDate,setIssuedDate]=useState(todayLocal());
  const [quality,setQuality]=useState<ConversionQuality>((model.quality as ConversionQuality)||"medium");
  const [meshiqAdaptiveSmoothing,setMeshiqAdaptiveSmoothing]=useState<MeshiqAdaptiveSmoothing>("off");
  const [makeCurrent,setMakeCurrent]=useState(true);
  const [allowPublicSelectable,setAllowPublicSelectable]=useState(true);
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault(); if(!file)return;
    setBusy(true);setError(null);
    try{
      const result=await uploadNewRevision(model.slug,file,quality,{revisionLabel,issuedDate,makeCurrent,allowPublicSelectable,meshiqAdaptiveSmoothing},setProgress);
      onDone(`Rev ${result.revision.revision_label} uploaded${makeCurrent?" and set as current":""}.`);
    }catch(reason){setError(reason instanceof Error?reason.message:"Revision upload failed.");setBusy(false)}
  };
  return <Dialog title={`Upload new revision — ${model.name}`} onClose={busy?()=>{}:onClose}><form className="dialog-form" onSubmit={submit}>
    <FilePicker file={file} busy={busy} dxfUploadEnabled={dxfUploadEnabled} onChange={setFile}/>
    <div className="revision-fields">
      <label>Revision<input className="field" value={revisionLabel} disabled={busy} maxLength={100} onChange={e=>setRevisionLabel(e.target.value)} placeholder="Auto-number"/><small>Leave blank to auto-number.</small></label>
      <label>Date issued<input className="field" type="date" value={issuedDate} disabled={busy} onChange={e=>setIssuedDate(e.target.value)}/></label>
    </div>
    <fieldset disabled={busy}><legend>Quality</legend><QualityOptions value={quality} onChange={setQuality}/></fieldset>
    <fieldset disabled={busy}><legend>Advanced / Experimental</legend><MeshIqSmoothingOptions value={meshiqAdaptiveSmoothing} onChange={setMeshiqAdaptiveSmoothing}/><p className="field-help">Experimental. Smooths large curved parts such as tanks and long tubes. Off is safest.</p></fieldset>
    <label className="checkbox-field"><input type="checkbox" checked={makeCurrent} disabled={busy} onChange={e=>setMakeCurrent(e.target.checked)}/><span><strong>Make this the current revision after processing</strong></span></label>
    <label className="checkbox-field"><input type="checkbox" checked={allowPublicSelectable} disabled={busy} onChange={e=>setAllowPublicSelectable(e.target.checked)}/><span><strong>Available in public revision dropdown</strong></span></label>
    {busy&&<UploadProgress percent={progress} text={progress<100?"Uploading revision…":"Upload complete. Creating revision…"}/>}
    {error&&<div className="alert error">{error}</div>}
    <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!file||busy}>{busy?<Loader2 className="animate-spin"/>:<Upload/>}Upload revision</button></div>
  </form></Dialog>;
}

function ShareSettingsDialog({model,onClose}:{model:ModelRecord;onClose:()=>void}) {
  const [detail,setDetail]=useState<ModelRecord|null>(null);
  const [linkMode,setLinkMode]=useState<PublicShareLinkMode>("locked_revision");
  const [revisionId,setRevisionId]=useState("");
  const [allowRevisionSwitching,setAllowRevisionSwitching]=useState(false);
  const [shareUrl,setShareUrl]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);

  useEffect(()=>{
    let cancelled=false;
    void Promise.all([getModel(model.slug),getPublicShareSettings(model.id)])
      .then(([nextDetail,settings])=>{
        if(cancelled)return;
        const revisions=nextDetail.revisions??[];
        const currentId=nextDetail.currentRevision?.id??revisions.find(revision=>revision.is_current)?.id??revisions[0]?.id;
        setDetail(nextDetail);
        setLinkMode(settings.linkMode??"locked_revision");
        setRevisionId(String(settings.revisionId??currentId??""));
        setAllowRevisionSwitching(settings.allowRevisionSwitching??false);
        setShareUrl(settings.url??null);
      })
      .catch(reason=>{if(!cancelled)setError(reason instanceof Error?reason.message:"Could not load share settings.")})
      .finally(()=>{if(!cancelled)setLoading(false)});
    return()=>{cancelled=true};
  },[model.id,model.slug]);

  const revisions=detail?.revisions??[];
  const readyRevisions=revisions.filter(revision=>revision.status==="ready");
  const selectableAlternatives=readyRevisions.filter(revision=>revision.is_publicly_selectable).length;
  const selectedRevision=readyRevisions.find(revision=>String(revision.id)===revisionId);
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();
    if(linkMode==="locked_revision"&&!selectedRevision){setError("Choose a ready revision to lock this share to.");return}
    setBusy(true);setError(null);setNotice(null);
    try{
      const share=await createPublicShare(model.id,{
        linkMode,
        revisionId:linkMode==="locked_revision"?Number(revisionId):null,
        allowRevisionSwitching
      });
      setShareUrl(share.url);
      setNotice("Share settings saved. The existing token was preserved when a share already existed.");
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not save share settings.")}
    finally{setBusy(false)}
  };
  const copyShare=async()=>{if(!shareUrl)return;await copyText(shareUrl);setNotice("Share link copied.")};
  const downloadQr=async()=>{if(!shareUrl)return;await downloadPublicShareQr(shareUrl,model.slug);setNotice("QR code downloaded.")};

  return <Dialog title={`Share link and QR — ${model.name}`} onClose={busy?()=>{}:onClose}>
    <form className="dialog-form share-settings-form" onSubmit={save}>
      {loading&&<div className="revision-loading"><Loader2 className="animate-spin"/>Loading share settings…</div>}
      {!loading&&<>
        <fieldset disabled={busy}>
          <legend>Share link mode</legend>
          <label className={`share-mode-option ${linkMode==="locked_revision"?"selected":""}`}>
            <input type="radio" name="shareMode" checked={linkMode==="locked_revision"} onChange={()=>setLinkMode("locked_revision")}/>
            <span><strong>Locked to this revision</strong><small>Best for issued drawings and QR codes. Future revisions will not change this link.</small></span>
          </label>
          <label className={`share-mode-option ${linkMode==="latest_current"?"selected":""}`}>
            <input type="radio" name="shareMode" checked={linkMode==="latest_current"} onChange={()=>setLinkMode("latest_current")}/>
            <span><strong>Latest/current revision</strong><small>Best for internal live coordination. This link follows the model’s current revision.</small></span>
          </label>
        </fieldset>
        {linkMode==="locked_revision"&&<label>Selected locked revision
          <select className="field" value={revisionId} disabled={busy||readyRevisions.length<2} onChange={event=>setRevisionId(event.target.value)}>
            <option value="">Choose a ready revision</option>
            {readyRevisions.map(revision=><option key={revision.id} value={revision.id}>Rev {revision.revision_label}{revision.is_current?" — Current":""}</option>)}
          </select>
          <small>{readyRevisions.length===1?"This model has one ready revision, so the share will stay locked to it.":"Only ready revisions can be used for public shares."}</small>
        </label>}
        <label className="checkbox-field"><input type="checkbox" checked={allowRevisionSwitching} disabled={busy} onChange={event=>setAllowRevisionSwitching(event.target.checked)}/><span><strong>Allow public revision switching</strong><small>Public viewers can switch only to revisions marked available in the public revision dropdown.</small>{allowRevisionSwitching&&selectableAlternatives<2?<small>There are not currently multiple ready public-selectable revisions.</small>:null}</span></label>
        <div className="share-download-note"><strong>Download permissions are unchanged.</strong><span>Original/source and GLB download access continues to follow the existing share behaviour.</span></div>
        {shareUrl&&<div className="share-link-preview"><span>Current public link</span><code>{shareUrl}</code></div>}
        {error&&<div className="alert error">{error}</div>}
        {notice&&<div className="alert"><Check size={16}/>{notice}</div>}
        <div className="dialog-actions share-dialog-actions">
          {shareUrl&&<><button type="button" className="secondary-button" disabled={busy} onClick={()=>void copyShare()}><Copy/>Copy link</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>void downloadQr()}><QrCode/>Download QR</button></>}
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Close</button>
          <button className="primary-button" disabled={busy||readyRevisions.length===0}>{busy?<Loader2 className="animate-spin"/>:<Share2/>}Save settings</button>
        </div>
      </>}
    </form>
  </Dialog>;
}

function ReplaceRevisionDialog({model,dxfUploadEnabled,initialRevisionId,onClose,onDone}:{model:ModelRecord;dxfUploadEnabled:boolean;initialRevisionId?:number;onClose:()=>void;onDone:(message:string)=>void}) {
  const [revisions,setRevisions]=useState<ModelRevisionRecord[]>([]);
  const [revisionId,setRevisionId]=useState(initialRevisionId?String(initialRevisionId):"");
  const [reason,setReason]=useState("");
  const [quality,setQuality]=useState<ConversionQuality>((model.quality as ConversionQuality)||"medium");
  const [file,setFile]=useState<File|null>(null);
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const replacementTooLarge=Boolean(file&&file.size>83886080);
  useEffect(()=>{void getModel(model.slug).then(detail=>{const next=detail.revisions??[];setRevisions(next);setRevisionId(current=>current||String(detail.currentRevision?.id??next[0]?.id??""))}).catch(reason=>setError(reason instanceof Error?reason.message:"Could not load revisions."))},[model.slug]);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!file||!revisionId)return;
    if(file.size>83886080){setError("Replacement files over 80 MB are not supported in this screen yet because chunked replacement upload is deferred. Use a smaller export or wait for chunked replacement support.");return}
    setBusy(true);setError(null);
    try{
      const result=await replaceRevision(model.slug,Number(revisionId),file,quality,reason,setProgress);
      onDone(`Rev ${result.revision.revision_label} replacement uploaded successfully.`);
    }catch(reason){setError(reason instanceof Error?reason.message:"Replacement upload failed.");setBusy(false)}
  };
  return <Dialog title={`Replace revision — ${model.name}`} onClose={busy?()=>{}:onClose}><form className="dialog-form" onSubmit={submit}>
    <div className="revision-warning">Use this only to fix a bad upload/export/conversion for the same issued revision. Existing locked QR/share links to this revision will show the replacement model after processing. For real design changes, upload a new revision instead.</div>
    <label>Revision to replace<select className="field" value={revisionId} disabled={busy} onChange={e=>setRevisionId(e.target.value)}><option value="">Select a revision</option>{revisions.map(revision=><option key={revision.id} value={revision.id}>Rev {revision.revision_label}{revision.is_current?" — Current":""}</option>)}</select></label>
    <label>Replacement reason<textarea className="field textarea-field" value={reason} disabled={busy} maxLength={2000} onChange={e=>setReason(e.target.value)} placeholder="What was corrected?"/></label>
    <fieldset disabled={busy}><legend>Quality</legend><QualityOptions value={quality} onChange={setQuality}/></fieldset>
    <FilePicker file={file} busy={busy} dxfUploadEnabled={dxfUploadEnabled} onChange={setFile}/>
    {replacementTooLarge&&<div className="alert error">This replacement is over 80 MB. Chunked replacement upload is deferred, so this screen cannot upload it safely yet. Use a smaller export or wait for chunked replacement support.</div>}
    {busy&&<UploadProgress percent={progress} text={progress<100?"Uploading replacement…":"Upload complete. Creating conversion job…"}/>}
    {error&&<div className="alert error">{error}</div>}
    <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!file||!revisionId||busy||replacementTooLarge}>{busy?<Loader2 className="animate-spin"/>:<Replace/>}Replace revision</button></div>
  </form></Dialog>;
}

function ManageRevisionsDialog({model,onClose,onReplace,onChanged}:{model:ModelRecord;onClose:()=>void;onReplace:(revisionId:number)=>void;onChanged:()=>void}) {
  const [detail,setDetail]=useState<ModelRecord|null>(null);
  const [busyId,setBusyId]=useState<number|null>(null);
  const [error,setError]=useState<string|null>(null);
  const load=async()=>{try{setDetail(await getModel(model.slug));setError(null)}catch(reason){setError(reason instanceof Error?reason.message:"Could not load revisions.")}};
  useEffect(()=>{void load()},[model.slug]);
  const mutate=async(revisionId:number,operation:()=>Promise<unknown>)=>{setBusyId(revisionId);setError(null);try{await operation();await load();onChanged()}catch(reason){setError(reason instanceof Error?reason.message:"Revision update failed.")}finally{setBusyId(null)}};
  const revisions=detail?.revisions??[];
  return <Dialog title={`Manage revisions — ${model.name}`} onClose={onClose} wide><div className="revision-manager">
    {error&&<div className="alert error">{error}</div>}
    {!detail&&!error&&<div className="revision-loading"><Loader2 className="animate-spin"/>Loading revisions…</div>}
    {detail&&<div className="revision-table-scroll"><table className="revision-table"><thead><tr><th>Revision</th><th>Issued date</th><th>Status</th><th>Current</th><th>Public selectable</th><th>Source size</th><th>GLB size</th><th>Uploaded date</th><th>Actions</th></tr></thead><tbody>
      {revisions.map(revision=>{const active=busyId===revision.id;const ready=revision.status==="ready";return <tr key={revision.id}><td><strong>Rev {revision.revision_label}</strong></td><td>{formatDateOnly(revision.issued_date)}</td><td><Status status={revision.status}/></td><td>{revision.is_current?<span className="current-pill"><Check/>Current</span>:"—"}</td><td><label className="switch-field"><input type="checkbox" checked={Boolean(revision.is_publicly_selectable)} disabled={active} onChange={e=>void mutate(revision.id,()=>updateRevisionPublicSelectable(model.slug,revision.id,e.target.checked))}/><span>{active?"Updating…":revision.is_publicly_selectable?"Available":"Hidden"}</span></label></td><td>{formatFileSize(revision.source_size_bytes)}</td><td>{formatFileSize(revision.glb_size_bytes)}</td><td>{formatDate(revision.uploaded_at)}</td><td><div className="revision-actions">{!revision.is_current&&<button title={ready?"Set as the model's current revision":"Only ready revisions can be made current"} disabled={active||!ready} onClick={()=>void mutate(revision.id,()=>makeRevisionCurrent(model.slug,revision.id))}>{active?"Updating…":"Make current"}</button>}<button disabled={active} onClick={()=>onReplace(revision.id)}>Replace</button></div></td></tr>})}
    </tbody></table></div>}
    <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Close</button></div>
  </div></Dialog>;
}

function FilePicker({file,busy,dxfUploadEnabled,onChange}:{file:File|null;busy:boolean;dxfUploadEnabled:boolean;onChange:(file:File|null)=>void}) {
  return <label className={`upload-drop compact ${busy?"disabled":""}`}><Upload/><strong>{file?.name??"Choose a model file"}</strong><span>{file?`${(file.size/(1024*1024)).toFixed(1)} MB`:`STEP, STP, GLB, GLTF${dxfUploadEnabled?", or DXF":""}`}</span><input type="file" accept={dxfUploadEnabled?".step,.stp,.glb,.gltf,.dxf":".step,.stp,.glb,.gltf"} disabled={busy} onChange={e=>onChange(e.target.files?.[0]??null)}/></label>;
}

function QualityOptions({value,onChange}:{value:ConversionQuality;onChange:(quality:ConversionQuality)=>void}) {
  return <div className="quality-options">{(["low","medium","high"] as const).map(quality=><button type="button" className={value===quality?"active":""} onClick={()=>onChange(quality)} key={quality}>{quality}</button>)}</div>;
}

function MeshIqSmoothingOptions({value,onChange}:{value:MeshiqAdaptiveSmoothing;onChange:(value:MeshiqAdaptiveSmoothing)=>void}) {
  const labels: Record<MeshiqAdaptiveSmoothing, string> = { off: "Off", standard: "Standard", strong: "Strong" };
  return <div className="quality-options">{(["off","standard","strong"] as const).map(option=><button type="button" className={value===option?"active":""} onClick={()=>onChange(option)} key={option}>{labels[option]}</button>)}</div>;
}

function UploadProgress({percent,text}:{percent:number;text:string}) {
  return <div className="upload-progress" role="status"><div className="upload-progress-heading"><strong>{percent}%</strong><span>{text}</span></div><div className="upload-progress-track"><span style={{width:`${percent}%`}}/></div></div>;
}

function MoveDialog({projects,busy,onClose,onMove}:{projects:ProjectRecord[];busy:boolean;onClose:()=>void;onMove:(id:number|null)=>void}){const[id,setId]=useState("");return <Dialog title="Move to project" onClose={onClose}><div className="dialog-form"><label>Destination<select className="field" value={id} onChange={e=>setId(e.target.value)}><option value="">Unsorted</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy} onClick={()=>onMove(id?Number(id):null)}>Move</button></div></div></Dialog>}
function ConfirmDialog({count,busy,onClose,onConfirm}:{count:number;busy:boolean;onClose:()=>void;onConfirm:()=>void}){return <Dialog title="Delete forever?" onClose={onClose}><div className="dialog-form"><p>This permanently deletes {count} item{count===1?"":"s"} and its files. This cannot be undone.</p><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="danger-button" disabled={busy} onClick={onConfirm}>Delete forever</button></div></div></Dialog>}
function Dialog({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:React.ReactNode;wide?:boolean}){return <div className="dialog-overlay" role="dialog" aria-modal="true"><div className={`dialog-card ${wide?"wide":""}`}><header><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={17}/></button></header>{children}</div></div>}
function todayLocal(){const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`}
function formatDateOnly(value:string){if(!value)return "—";const [year,month,day]=value.split("-").map(Number);return Number.isFinite(year)&&Number.isFinite(month)&&Number.isFinite(day)?new Intl.DateTimeFormat(undefined,{day:"numeric",month:"short",year:"numeric"}).format(new Date(year,month-1,day)):value}
function formatBytes(bytes:number){if(!Number.isFinite(bytes))return "—";const units=["B","KB","MB","GB","TB"];let value=bytes,i=0;while(value>=1024&&i<units.length-1){value/=1024;i++}return `${value.toFixed(i<2?0:value>=10?1:2)} ${units[i]}`}
