import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore, ArrowDown, ArrowUp, Box, Check, ChevronRight, Download, Folder,
  FolderOpen, HardDrive, List, Loader2, Menu, Moon, MoreVertical, Pencil, Plus,
  RefreshCw, Search, Sun, Trash2, Upload, X
} from "lucide-react";
import {
  batchModels, createProject, createPublicShare, deleteProject, getStorageQuota,
  listLibraryModels, listProjects, renameModel, renameProject, uploadModel
} from "../api";
import { downloadPublicShareQr } from "../qr";
import type { BatchAction, ConversionQuality, ModelListParams, ModelRecord, ProjectRecord, StorageQuota } from "../types";
import { activeStatuses, formatDate, formatFileSize, statusKind, statusLabel } from "../utils";

type View = { kind: "all" | "projects" | "unsorted" | "trash" } | { kind: "project"; id: number };
type SortBy = NonNullable<ModelListParams["sortBy"]>;
const sortable: Array<{ key: SortBy; label: string }> = [
  { key: "name", label: "Name" }, { key: "project", label: "Project" },
  { key: "status", label: "Status" }, { key: "glb_size_bytes", label: "GLB size" },
  { key: "original_size_bytes", label: "Original size" }, { key: "created_at", label: "Created" },
  { key: "updated_at", label: "Updated" }
];

export function AdminPage({ theme, toggleTheme }: { theme: "dark" | "light"; toggleTheme: () => void }) {
  const [view, setView] = useState<View>({ kind: "all" });
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteForeverOpen, setDeleteForeverOpen] = useState(false);
  const polling = useRef<number | undefined>(undefined);

  const project = view.kind === "project" ? projects.find((item) => item.id === view.id) : undefined;
  const title = view.kind === "all" ? "All models" : view.kind === "projects" ? "Projects" :
    view.kind === "unsorted" ? "Unsorted" : view.kind === "trash" ? "Recycling bin" : project?.name ?? "Project";

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);

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
  useEffect(() => {
    window.clearTimeout(polling.current);
    polling.current = window.setTimeout(() => void refresh(false), models.some((m) => activeStatuses.has(m.status)) ? 3000 : 15000);
    return () => window.clearTimeout(polling.current);
  }, [models, view, debouncedQuery, sortBy, sortDir]);

  const searchedProjects = useMemo(() => {
    const needle = debouncedQuery.toLowerCase();
    return needle ? projects.filter((item) => item.name.toLowerCase().includes(needle)) : projects;
  }, [projects, debouncedQuery]);

  const selectView = (next: View) => { setView(next); setQuery(""); setNotice(null); };
  const runBatch = async (action: BatchAction, projectId?: number | null) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await batchModels(action, [...selected], projectId);
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
    else window.setTimeout(() => void runBatch(action), 0);
  };

  return <div className="library-shell">
    <header className="library-header">
      <div className="brand"><span className="brand-mark"><Box size={20}/></span><strong>ModelBase</strong></div>
      <label className="global-search"><Search size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${view.kind === "projects" ? "projects" : "models"}`} /></label>
      <button className="icon-button" onClick={toggleTheme} title="Toggle theme">{theme === "dark" ? <Sun size={17}/> : <Moon size={17}/>}</button>
      <button className="primary-button" onClick={() => setUploadOpen(true)}><Upload size={16}/> Upload</button>
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
          <div><div className="breadcrumbs">{view.kind === "project" && <><button onClick={() => selectView({kind:"projects"})}>Projects</button><ChevronRight size={14}/></>}<span>{title}</span></div>
            <h1>{title}</h1>{view.kind === "trash" && <p>Items in the recycling bin still count toward storage.</p>}</div>
          <div className="heading-actions">{view.kind === "projects" && <button className="secondary-button" onClick={async () => { const name=window.prompt("Project name"); if(name){await createProject(name); await refresh();}}}><Plus size={16}/> New project</button>}
            <button className="icon-button" onClick={() => refresh(true)} title="Refresh"><RefreshCw className={loading ? "animate-spin" : ""} size={17}/></button></div>
        </div>
        {selected.size > 0 && <BatchToolbar trash={view.kind === "trash"} count={selected.size} busy={busy} onClear={() => setSelected(new Set())} onMove={() => setMoveOpen(true)} onTrash={() => void runBatch("trash")} onRestore={() => void runBatch("restore")} onDelete={() => setDeleteForeverOpen(true)}/>}
        {error && <div className="alert error">{error}</div>}{notice && <div className="alert"><Check size={16}/>{notice}</div>}
        <section className="asset-surface">
          {view.kind === "projects" ? <ProjectList projects={searchedProjects} onOpen={(id)=>selectView({kind:"project",id})} onRefresh={()=>refresh()} /> :
            <AssetTable models={models} loading={loading} trash={view.kind === "trash"} selected={selected} sortBy={sortBy} sortDir={sortDir}
              onSort={(key)=>{if(sortBy===key)setSortDir(d=>d==="asc"?"desc":"asc");else{setSortBy(key);setSortDir("asc");}}}
              onSelected={setSelected} onAction={rowAction} onRefresh={()=>refresh(false)}/>}
        </section>
      </main>
    </div>
    {uploadOpen && <UploadDialog projects={projects} defaultProjectId={view.kind === "project" ? view.id : null} onClose={()=>setUploadOpen(false)} onDone={async()=>{setUploadOpen(false);await refresh();}}/>}
    {moveOpen && <MoveDialog projects={projects} busy={busy} onClose={()=>setMoveOpen(false)} onMove={(id)=>void runBatch("moveToProject",id)}/>}
    {deleteForeverOpen && <ConfirmDialog count={selected.size} busy={busy} onClose={()=>setDeleteForeverOpen(false)} onConfirm={()=>void runBatch("deleteForever")}/>}
  </div>;
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

function AssetTable({models,loading,trash,selected,sortBy,sortDir,onSort,onSelected,onAction,onRefresh}:{models:ModelRecord[];loading:boolean;trash:boolean;selected:Set<string>;sortBy:SortBy;sortDir:"asc"|"desc";onSort:(k:SortBy)=>void;onSelected:(s:Set<string>)=>void;onAction:(m:ModelRecord,a:BatchAction)=>void;onRefresh:()=>void}) {
  const all=models.length>0&&models.every(m=>selected.has(m.slug));
  const toggle=(slug:string)=>{const next=new Set(selected);next.has(slug)?next.delete(slug):next.add(slug);onSelected(next)};
  if(loading&&!models.length)return <div className="empty-state"><Loader2 className="animate-spin"/><strong>Loading assets…</strong></div>;
  if(!models.length)return <div className="empty-state"><Box/><strong>{trash?"Recycling bin is empty.":"No models here yet."}</strong><span>{trash?"Deleted models will appear here.":"Upload a model or choose another view."}</span></div>;
  return <div className="table-scroll"><table className="asset-table"><thead><tr><th className="check-cell"><input type="checkbox" checked={all} onChange={()=>onSelected(all?new Set():new Set(models.map(m=>m.slug)))} aria-label="Select all visible"/></th>
    {sortable.map(c=><th key={c.key}><button className="sort-button" onClick={()=>onSort(c.key)}>{c.label}{sortBy===c.key&&(sortDir==="asc"?<ArrowUp/>:<ArrowDown/>)}</button></th>)}<th className="action-cell">Actions</th></tr></thead>
    <tbody>{models.map(model=><tr key={model.slug} className={selected.has(model.slug)?"selected":""}><td className="check-cell"><input type="checkbox" checked={selected.has(model.slug)} onChange={()=>toggle(model.slug)} aria-label={`Select ${model.name}`}/></td>
      <td><a className="model-name" href={`/3dviewer/${encodeURIComponent(model.slug)}`}><span className="file-icon"><Box size={17}/></span><span><strong>{model.name}</strong><small>{model.source_filename}</small></span></a></td>
      <td>{model.project_name??<span className="muted">Unsorted</span>}</td><td><Status status={model.status}/></td><td>{formatFileSize(model.glb_size_bytes)}</td><td>{formatFileSize(model.original_size_bytes)}</td><td>{formatDate(model.created_at)}</td><td>{formatDate(model.updated_at)}</td>
      <td className="action-cell"><RowMenu model={model} trash={trash} onAction={onAction} onRefresh={onRefresh}/></td></tr>)}</tbody></table></div>;
}

function Status({status}:{status:string}){return <span className={`compact-status ${statusKind(status)}`}><span/>{statusLabel(status)}</span>}

function RowMenu({model,trash,onAction,onRefresh}:{model:ModelRecord;trash:boolean;onAction:(m:ModelRecord,a:BatchAction)=>void;onRefresh:()=>void}) {
  const [open,setOpen]=useState(false);
  return <div className="row-menu"><button className="menu-button" onClick={()=>setOpen(!open)} aria-label={`Actions for ${model.name}`}><MoreVertical size={17}/></button>{open&&<><button className="menu-backdrop" onClick={()=>setOpen(false)}/><div className="menu-popover">
    {!trash&&<><a href={`/3dviewer/${encodeURIComponent(model.slug)}`}><Box/>Open viewer</a><a className={!model.has_display_glb?"disabled":""} href={model.has_display_glb?`/downloads/${encodeURIComponent(model.slug)}/display.glb`:undefined}><Download/>Download GLB</a><a href={`/admin/logs/${encodeURIComponent(model.slug)}/conversion.log`}><List/>Log</a>
      <button onClick={async()=>{const name=window.prompt("Model name",model.name);if(name&&name!==model.name){await renameModel(model.slug,name);onRefresh()}setOpen(false)}}><Pencil/>Rename</button>
      <button onClick={()=>{onAction(model,"moveToProject");setOpen(false)}}><FolderOpen/>Move to project</button><button className="danger-item" onClick={()=>{onAction(model,"trash");setOpen(false)}}><Trash2/>Move to recycling bin</button></>}
    {trash&&<><button onClick={()=>{onAction(model,"restore");setOpen(false)}}><ArchiveRestore/>Restore</button><button className="danger-item" onClick={()=>{onAction(model,"deleteForever");setOpen(false)}}><Trash2/>Delete forever</button></>}
    <button onClick={async()=>{const share=await createPublicShare(model.id);await downloadPublicShareQr(share.url,model.slug);setOpen(false)}} className={trash?"hidden":""}><Menu/>Download QR link</button>
  </div></>}</div>;
}

function ProjectList({projects,onOpen,onRefresh}:{projects:ProjectRecord[];onOpen:(id:number)=>void;onRefresh:()=>void}) {
  if(!projects.length)return <div className="empty-state"><Folder/><strong>No projects yet.</strong><span>Create a project to organise your models.</span></div>;
  return <div className="project-list">{projects.map(p=><div className="project-row" key={p.id} onDoubleClick={()=>onOpen(p.id)}><button className="project-open" onClick={()=>onOpen(p.id)}><span className="project-folder"><Folder size={20}/></span><span><strong>{p.name}</strong><small>{p.model_count} model{p.model_count===1?"":"s"}</small></span></button><span>{formatBytes(p.total_size_bytes)}</span><span>Updated {formatDate(p.updated_at)}</span><div className="project-actions"><button className="icon-button" title="Rename" onClick={async()=>{const name=window.prompt("Project name",p.name);if(name&&name!==p.name){await renameProject(p.id,name);onRefresh()}}}><Pencil size={15}/></button><button className="icon-button" title={p.model_count?"Move all models out before deleting":"Delete empty project"} disabled={p.model_count>0} onClick={async()=>{if(window.confirm(`Delete empty project “${p.name}”?`)){await deleteProject(p.id);onRefresh()}}}><Trash2 size={15}/></button></div></div>)}</div>;
}

function BatchToolbar({trash,count,busy,onClear,onMove,onTrash,onRestore,onDelete}:{trash:boolean;count:number;busy:boolean;onClear:()=>void;onMove:()=>void;onTrash:()=>void;onRestore:()=>void;onDelete:()=>void}){return <div className="batch-toolbar"><strong>{count} selected</strong><span className="batch-spacer"/>{trash?<><button onClick={onRestore} disabled={busy}><ArchiveRestore/>Restore</button><button className="danger-action" onClick={onDelete} disabled={busy}><Trash2/>Delete forever</button></>:<><button onClick={onMove} disabled={busy}><FolderOpen/>Move to project</button><button onClick={onTrash} disabled={busy}><Trash2/>Move to recycling bin</button></>}<button className="batch-close" onClick={onClear}><X/></button></div>}

function UploadDialog({projects,defaultProjectId,onClose,onDone}:{projects:ProjectRecord[];defaultProjectId:number|null;onClose:()=>void;onDone:()=>void}){const[file,setFile]=useState<File|null>(null);const[projectId,setProjectId]=useState(defaultProjectId?String(defaultProjectId):"");const[quality,setQuality]=useState<ConversionQuality>("medium");const[busy,setBusy]=useState(false);const[error,setError]=useState<string|null>(null);return <Dialog title="Upload model" onClose={onClose}><form onSubmit={async e=>{e.preventDefault();if(!file)return;setBusy(true);setError(null);try{await uploadModel(file,projectId?Number(projectId):null,quality);onDone()}catch(r){setError(r instanceof Error?r.message:"Upload failed");setBusy(false)}}} className="dialog-form"><label className="upload-drop"><Upload/><strong>{file?.name??"Choose a model file"}</strong><span>STEP, STP, GLB or GLTF up to 250 MB</span><input type="file" accept=".step,.stp,.glb,.gltf" onChange={e=>setFile(e.target.files?.[0]??null)}/></label><label>Project<select className="field" value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">Unsorted</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><fieldset><legend>Conversion quality</legend><div className="quality-options">{(["low","medium","high"] as const).map(q=><button type="button" className={quality===q?"active":""} onClick={()=>setQuality(q)} key={q}>{q}</button>)}</div></fieldset>{error&&<div className="alert error">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!file||busy}>{busy?<Loader2 className="animate-spin"/>:<Upload/>}Upload</button></div></form></Dialog>}
function MoveDialog({projects,busy,onClose,onMove}:{projects:ProjectRecord[];busy:boolean;onClose:()=>void;onMove:(id:number|null)=>void}){const[id,setId]=useState("");return <Dialog title="Move to project" onClose={onClose}><div className="dialog-form"><label>Destination<select className="field" value={id} onChange={e=>setId(e.target.value)}><option value="">Unsorted</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy} onClick={()=>onMove(id?Number(id):null)}>Move</button></div></div></Dialog>}
function ConfirmDialog({count,busy,onClose,onConfirm}:{count:number;busy:boolean;onClose:()=>void;onConfirm:()=>void}){return <Dialog title="Delete forever?" onClose={onClose}><div className="dialog-form"><p>This permanently deletes {count} item{count===1?"":"s"} and its files. This cannot be undone.</p><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="danger-button" disabled={busy} onClick={onConfirm}>Delete forever</button></div></div></Dialog>}
function Dialog({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){return <div className="dialog-overlay" role="dialog" aria-modal="true"><div className="dialog-card"><header><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={17}/></button></header>{children}</div></div>}
function formatBytes(bytes:number){if(!Number.isFinite(bytes))return "—";const units=["B","KB","MB","GB","TB"];let value=bytes,i=0;while(value>=1024&&i<units.length-1){value/=1024;i++}return `${value.toFixed(i<2?0:value>=10?1:2)} ${units[i]}`}
