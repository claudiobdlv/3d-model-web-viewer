import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Box,
  CheckCircle2,
  ChevronLeft,
  Download,
  FileText,
  Folder,
  FolderOpen,
  List,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  createFolder as createFolderApi,
  deleteFolder as deleteFolderApi,
  deleteModel as deleteModelApi,
  listFolders,
  listModels,
  moveModel as moveModelApi,
  renameFolder as renameFolderApi,
  renameModel as renameModelApi,
  uploadModel
} from "./api";
import type { FolderRecord, FolderSelection, ModelRecord } from "./types";
import {
  activeStatuses,
  fileKind,
  folderName,
  folderNameForModel,
  formatDate,
  hasActiveModels,
  selectedFolderId,
  statusKind,
  statusLabel
} from "./utils";
import { ViewerPage } from "./viewer/ViewerPage";
import "./index.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
type OpenMenu = { slug: string; x: number; y: number } | null;

function App() {
  if (window.location.pathname.startsWith("/3dviewer/")) {
    return <ViewerPage />;
  }

  return <AdminPage />;
}

function AdminPage() {
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [selection, setSelection] = useState<FolderSelection>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const pollingRef = useRef<number | null>(null);

  const currentFolderName = folderName(selection, folders);
  const targetFolderId = selectedFolderId(selection);

  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) =>
      [model.name, model.slug, model.source_filename, model.status, folderNameForModel(model, folders)]
        .some((value) => String(value ?? "").toLowerCase().includes(needle))
    );
  }, [folders, models, query]);

  const refresh = async (mode: "initial" | "quiet" | "manual" = "quiet") => {
    if (mode !== "quiet") setLoading(true);
    setError(null);
    try {
      const [nextFolders, nextModels] = await Promise.all([listFolders(), listModels(selection)]);
      setFolders(nextFolders);
      setModels(nextModels);
      setLastUpdated(new Date());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not refresh models.");
    } finally {
      if (mode !== "quiet") setLoading(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    void refresh("initial");
  }, [selection]);

  useEffect(() => {
    if (pollingRef.current) window.clearTimeout(pollingRef.current);
    const delay = hasActiveModels(models) ? 3000 : 15000;
    pollingRef.current = window.setTimeout(() => void refresh("quiet"), delay);
    return () => {
      if (pollingRef.current) window.clearTimeout(pollingRef.current);
    };
  }, [models, selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setUploadOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const allModelCount = selection === "all" ? models.length : null;
  const readyCount = models.filter((model) => model.status === "ready").length;
  const activeCount = models.filter((model) => activeStatuses.has(model.status)).length;

  return (
    <div className="min-h-screen overflow-hidden" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b px-4 backdrop-blur-xl" style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--bg) 94%, transparent)" }}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded bg-[var(--accent-strong)] text-[var(--accent-text)]">
            <Box size={20} />
          </div>
          <div className="min-w-0">
            <strong className="block truncate font-display text-base text-[var(--accent)]">ModelBase</strong>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <label className="hidden h-9 w-[min(280px,28vw)] min-w-48 items-center gap-2 rounded border px-3 md:flex" style={{ borderColor: "var(--line)", background: "var(--panel-soft)", color: "var(--subtle)" }}>
            <Search size={16} />
            <input className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" type="search" />
          </label>
          <button className="primary-button" type="button" onClick={() => setUploadOpen(true)}>
            <Upload size={16} />
            Upload
          </button>
        </div>
      </header>

      <main className="grid h-[calc(100vh-3.5rem)] grid-cols-1 overflow-hidden lg:grid-cols-[288px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r" style={{ borderColor: "var(--line)", background: "var(--panel-soft)" }}>
          <section className="p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h1 className="font-display text-xl font-bold">File manager</h1>
              </div>
              <button className="icon-button" type="button" title="Create folder" aria-label="Create folder" onClick={async () => {
                const name = window.prompt("Folder name");
                if (!name) return;
                const folder = await createFolderApi(name);
                setSelection(folder.id);
                await refresh("manual");
              }}>
                <Plus size={17} />
              </button>
            </div>
            <FolderList folders={folders} models={models} selection={selection} onSelect={setSelection} onRefresh={() => refresh("manual")} />
          </section>
          <section className="mt-auto hidden border-t p-4 lg:block" style={{ borderColor: "var(--line)" }}>
            <div className="mb-2 flex items-center justify-between text-[10px] font-extrabold uppercase tracking-[0.08em]" style={{ color: "var(--subtle)" }}>
              <span>Ready models</span>
              <strong>{models.length ? Math.round((readyCount / models.length) * 100) : 0}%</strong>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--panel-strong)" }}>
              <span className="block h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${models.length ? (readyCount / models.length) * 100 : 0}%` }} />
            </div>
            <p className="mt-3 text-xs leading-5" style={{ color: "var(--subtle)" }}>
              {(allModelCount ?? models.length)} models in view, {readyCount} ready, {activeCount} active conversions.
            </p>
          </section>
        </aside>

        <section className="min-w-0 overflow-auto p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 md:hidden">
            <label className="flex h-9 items-center gap-2 rounded border px-3" style={{ borderColor: "var(--line)", background: "var(--panel-soft)", color: "var(--subtle)" }}>
              <Search size={16} />
              <input className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" type="search" />
            </label>
          </div>

          <div className="overflow-visible rounded border" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
            <div className="flex items-start justify-between gap-4 border-b p-4 md:p-5" style={{ borderColor: "var(--line)" }}>
              <div className="min-w-0">
                <span className="eyebrow">Asset library</span>
                <h2 className="truncate font-display text-xl font-bold">{currentFolderName}</h2>
                <p className="mt-1 text-sm" style={{ color: "var(--subtle)" }}>
                  {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}.` : "Live refresh is starting."}
                  {hasActiveModels(models) ? " Watching active conversions." : " Quiet refresh active."}
                </p>
              </div>
              <button className="icon-button" type="button" aria-label="Refresh models" title="Refresh models" onClick={() => refresh("manual")}>
                <RefreshCw size={17} className={loading ? "animate-spin" : ""} />
              </button>
            </div>
            {error ? <div className="m-4 rounded border border-red-400/50 p-3 text-sm text-red-200">{error}</div> : null}
            <ModelTable
              models={filteredModels}
              folders={folders}
              loading={loading}
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              onMove={async (slug, folderId) => {
                await moveModelApi(slug, folderId);
                await refresh("quiet");
              }}
              onRename={async (model) => {
                const name = window.prompt("Model display name", model.name);
                if (!name || name === model.name) return;
                await renameModelApi(model.slug, name);
                await refresh("quiet");
              }}
              onDelete={async (model) => {
                if (!window.confirm(`Delete this model and all files? This cannot be undone.\n\n${model.name}`)) return;
                await deleteModelApi(model.slug);
                setOpenMenu(null);
                await refresh("manual");
              }}
            />
          </div>
        </section>
      </main>

      {uploadOpen ? (
        <UploadModal
          folders={folders}
          selection={selection}
          targetFolderId={targetFolderId}
          targetFolderName={currentFolderName}
          onClose={() => setUploadOpen(false)}
          onUploaded={async () => {
            await refresh("manual");
            setUploadOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function FolderList({ folders, models, selection, onSelect, onRefresh }: {
  folders: FolderRecord[];
  models: ModelRecord[];
  selection: FolderSelection;
  onSelect: (selection: FolderSelection) => void;
  onRefresh: () => Promise<void>;
}) {
  const items = [
    { id: "all" as const, name: "All Models", count: models.length, icon: FolderOpen },
    { id: "unsorted" as const, name: "Unsorted", count: models.filter((model) => model.folder_id === null).length, icon: List },
    ...folders.map((folder) => ({ id: folder.id, name: folder.name, count: folder.model_count ?? 0, icon: Folder }))
  ];

  return (
    <nav className="grid gap-1" aria-label="File manager folders">
      {items.map((item) => {
        const Icon = item.icon;
        const active = selection === item.id;
        return (
          <div key={String(item.id)} className="rounded" style={{ background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent" }}>
            <button className="grid h-10 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 text-left text-sm font-bold transition hover:bg-[var(--panel-strong)]" type="button" onClick={() => onSelect(item.id)}>
              <Icon size={17} style={{ color: active ? "var(--accent)" : "var(--muted)" }} />
              <span className="truncate">{item.name}</span>
              <span className="font-display text-[11px]" style={{ color: "var(--subtle)" }}>{item.count}</span>
            </button>
            {typeof item.id === "number" ? (
              <div className="flex gap-1 px-9 pb-2">
                <button className="secondary-button h-7 px-2 text-xs" type="button" onClick={async () => {
                  const name = window.prompt("Folder name", item.name);
                  if (!name || name === item.name) return;
                  await renameFolderApi(item.id, name);
                  await onRefresh();
                }}>
                  Rename
                </button>
                <button className="secondary-button h-7 px-2 text-xs text-[var(--failed)]" type="button" onClick={async () => {
                  if (item.count > 0) {
                    window.alert(`This folder contains ${item.count} models. Move or delete the models before deleting this folder.`);
                    return;
                  }
                  if (!window.confirm(`Delete folder "${item.name}"?`)) return;
                  await deleteFolderApi(item.id);
                  await onRefresh();
                }}>
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

function ModelTable({ models, folders, loading, openMenu, setOpenMenu, onMove, onRename, onDelete }: {
  models: ModelRecord[];
  folders: FolderRecord[];
  loading: boolean;
  openMenu: OpenMenu;
  setOpenMenu: (menu: OpenMenu) => void;
  onMove: (slug: string, folderId: number | null) => Promise<void>;
  onRename: (model: ModelRecord) => Promise<void>;
  onDelete: (model: ModelRecord) => Promise<void>;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [setOpenMenu]);

  if (loading && models.length === 0) {
    return <div className="grid min-h-52 place-items-center text-sm" style={{ color: "var(--subtle)" }}><Loader2 className="animate-spin" size={22} /></div>;
  }

  if (models.length === 0) {
    return (
      <div className="grid min-h-52 place-items-center gap-2 p-8 text-center" style={{ color: "var(--subtle)" }}>
        <Box size={34} />
        <p>No models in this view yet.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[840px] table-fixed border-collapse">
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[14%]" />
          <col className="w-[16%]" />
          <col className="w-[18%]" />
          <col className="w-[12%]" />
          <col className="w-[10%]" />
        </colgroup>
        <thead>
          <tr className="border-b text-left font-display text-[11px] font-extrabold uppercase tracking-[0.06em]" style={{ borderColor: "var(--line)", background: "var(--panel-soft)", color: "var(--muted)" }}>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3">Folder</th>
            <th className="px-4 py-3 text-right">View</th>
            <th className="px-4 py-3 text-right">More</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.slug} className="border-b transition-colors hover:bg-[var(--panel-soft)]" style={{ borderColor: "var(--line-soft)" }}>
              <td className="px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded border text-[var(--accent)]" style={{ borderColor: "var(--line)", background: "var(--panel-strong)" }}>
                    <Box size={19} />
                  </div>
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">{model.name}</strong>
                    <span className="block truncate text-xs" style={{ color: "var(--subtle)" }}>{model.source_filename}</span>
                    <span className="mt-1 inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px]" style={{ borderColor: "var(--line)", color: "var(--subtle)" }}>{fileKind(model.source_ext)}</span>
                  </div>
                </div>
              </td>
              <td className="px-4 py-3"><StatusCell status={model.status} /></td>
              <td className="px-4 py-3 text-xs" style={{ color: "var(--subtle)" }}>{formatDate(model.created_at)}</td>
              <td className="px-4 py-3">
                <select className="field w-36" value={model.folder_id ?? ""} aria-label={`Move ${model.name} to folder`} onChange={(event) => onMove(model.slug, event.target.value ? Number(event.target.value) : null)}>
                  <option value="">Unsorted</option>
                  {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>
              </td>
              <td className="px-4 py-3 text-right">
                {model.has_display_glb ? (
                  <a className="primary-button h-8 px-3 text-xs" href={`/3dviewer/${encodeURIComponent(model.slug)}`}>View</a>
                ) : (
                  <span className="secondary-button h-8 cursor-not-allowed px-3 text-xs opacity-50">View</span>
                )}
              </td>
              <td className="relative px-4 py-3 text-right">
                <button className="icon-button h-8 w-8" type="button" aria-label={`More options for ${model.name}`} onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setOpenMenu(openMenu?.slug === model.slug ? null : { slug: model.slug, x: rect.left, y: rect.top + rect.height / 2 });
                }}>
                  <MoreVertical size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {openMenu ? (
        <RowMenu
          menuRef={menuRef}
          menu={openMenu}
          model={models.find((model) => model.slug === openMenu.slug) ?? null}
          onRename={onRename}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );
}

function RowMenu({ menuRef, menu, model, onRename, onDelete }: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  menu: { slug: string; x: number; y: number };
  model: ModelRecord | null;
  onRename: (model: ModelRecord) => Promise<void>;
  onDelete: (model: ModelRecord) => Promise<void>;
}) {
  if (!model) return null;

  return (
    <div
      ref={menuRef}
      className="menu-enter fixed z-50 w-44 rounded border p-1 text-left shadow-menu"
      style={{
        left: Math.max(12, menu.x - 188),
        top: Math.max(64, menu.y - 18),
        borderColor: "var(--line)",
        background: "var(--panel)"
      }}
    >
      <MenuLink href={`/downloads/${encodeURIComponent(model.slug)}/display.glb`} disabled={!model.has_display_glb} icon={<Download size={15} />} label="Download GLB" />
      <MenuLink href={`/downloads/${encodeURIComponent(model.slug)}/original`} icon={<FileText size={15} />} label="Download STEP" />
      <MenuLink href={`/admin/logs/${encodeURIComponent(model.slug)}/conversion.log`} icon={<List size={15} />} label="Log" />
      <button className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm hover:bg-[var(--panel-strong)]" type="button" onClick={() => onRename(model)}>
        <Pencil size={15} /> Rename
      </button>
      <button className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-[var(--failed)] hover:bg-[var(--panel-strong)]" type="button" onClick={() => onDelete(model)}>
        <Trash2 size={15} /> Delete
      </button>
    </div>
  );
}

function MenuLink({ href, icon, label, disabled }: { href: string; icon: React.ReactNode; label: string; disabled?: boolean }) {
  if (disabled) {
    return <span className="flex w-full cursor-not-allowed items-center gap-2 rounded px-3 py-2 text-sm opacity-40">{icon} {label}</span>;
  }
  return <a className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm hover:bg-[var(--panel-strong)]" href={href}>{icon} {label}</a>;
}

function StatusCell({ status }: { status: string }) {
  const kind = statusKind(status);
  const color = kind === "ready" ? "var(--ready)" : kind === "failed" ? "var(--failed)" : kind === "processing" ? "var(--processing)" : "var(--queued)";
  return (
    <div className="grid w-[124px] gap-2">
      <span className="status-pill" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
        <span className="status-dot" />
        {statusLabel(status)}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--panel-strong)" }}>
        <span
          className={`block h-full rounded-full ${kind === "processing" ? "progress-sweep w-1/2" : ""}`}
          style={{
            background: color,
            width: kind === "ready" || kind === "failed" ? "100%" : kind === "processing" ? "45%" : "28%"
          }}
        />
      </span>
    </div>
  );
}

function UploadModal({ folders, selection, targetFolderId, targetFolderName, onClose, onUploaded }: {
  folders: FolderRecord[];
  selection: FolderSelection;
  targetFolderId: number | null;
  targetFolderName: string;
  onClose: () => void;
  onUploaded: () => Promise<void>;
}) {
  const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState<number | null>(targetFolderId);
  const [queue, setQueue] = useState<Array<{ name: string; state: "selected" | "uploading" | "done" | "failed"; error?: string }>>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resolvedTargetName = target ? folders.find((folder) => folder.id === target)?.name ?? "Folder" : selection === "all" ? "Unsorted" : targetFolderName;

  const submitFiles = async (files: FileList | File[]) => {
    const accepted = Array.from(files).filter((file) => /\.(step|stp|glb|gltf)$/i.test(file.name));
    setQueue(accepted.map((file) => ({ name: file.name, state: "selected" })));
    for (const file of accepted) {
      setQueue((items) => items.map((item) => item.name === file.name ? { ...item, state: "uploading" } : item));
      try {
        await uploadModel(file, target);
        setQueue((items) => items.map((item) => item.name === file.name ? { ...item, state: "done" } : item));
      } catch (error) {
        setQueue((items) => items.map((item) => item.name === file.name ? { ...item, state: "failed", error: error instanceof Error ? error.message : "Upload failed" } : item));
        return;
      }
    }
    if (accepted.length > 0) await onUploaded();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/62 p-4" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <div className="w-full max-w-xl rounded border shadow-panel" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
        <div className="flex items-center justify-between border-b p-4" style={{ borderColor: "var(--line)" }}>
          <div>
            <h2 id="upload-title" className="font-display text-lg font-bold">Upload model</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--subtle)" }}>STEP, STP, GLB, GLTF</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close upload modal"><X size={18} /></button>
        </div>
        <div className="grid gap-4 p-4">
          <label className="grid gap-2 text-sm font-bold">
            Selected target folder
            <select className="field w-full" value={target ?? ""} onChange={(event) => setTarget(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Unsorted</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <div
            className="grid min-h-48 place-items-center rounded border-2 border-dashed p-6 text-center transition"
            style={{ borderColor: dragging ? "var(--accent)" : "var(--line)", background: dragging ? "var(--panel-strong)" : "var(--panel-soft)" }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void submitFiles(event.dataTransfer.files);
            }}
          >
            <div className="grid place-items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded border text-[var(--accent)]" style={{ borderColor: "var(--line)" }}><Upload size={22} /></div>
              <div>
                <p className="font-bold">Drop files here</p>
                <p className="mt-1 text-sm" style={{ color: "var(--subtle)" }}>Uploading into {resolvedTargetName}</p>
              </div>
              <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>Browse files</button>
              <input ref={inputRef} className="hidden" type="file" accept=".step,.stp,.glb,.gltf" multiple onChange={(event) => event.target.files && submitFiles(event.target.files)} />
            </div>
          </div>
          {queue.length ? (
            <div className="grid gap-2">
              {queue.map((item) => (
                <div key={item.name} className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-sm" style={{ borderColor: "var(--line)", background: "var(--panel-soft)" }}>
                  <span className="truncate">{item.name}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs font-bold uppercase" style={{ color: item.state === "failed" ? "var(--failed)" : item.state === "done" ? "var(--ready)" : "var(--muted)" }}>
                    {item.state === "uploading" ? <Loader2 className="animate-spin" size={14} /> : item.state === "done" ? <CheckCircle2 size={14} /> : null}
                    {item.error ?? item.state}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t p-4" style={{ borderColor: "var(--line)" }}>
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

root.render(<App />);
