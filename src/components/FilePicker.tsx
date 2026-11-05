import { useMemo, useRef, useState } from "react";
import type { Language } from "../types";

export interface PickedFile {
  id: string;
  name: string;
  content: string;
  size: number;
  language: Language;
}

export interface GithubLoaded {
  path: string;
  name: string;
  content: string;
  size: number;
  language: Language;
}

interface GhItem {
  path: string;
  name: string;
  ext: string;
  kind: "code" | "text";
  language: Language;
  size: number;
  sha: string;
}

interface GhRepo {
  owner: string;
  repo: string;
  branch: string;
  ref: string;
  sha: string;
  private: boolean;
  stars: number;
  description: string;
  language: string;
  url: string;
}

interface GhTree {
  mode: "tree";
  repo: GhRepo;
  path: string;
  files: GhItem[];
  total: number;
  truncated: boolean;
  skipped: number;
  token: boolean;
}

export default function FilePicker({
  open,
  files,
  current,
  onFiles,
  onPick,
  onRemove,
  onGithubLoad,
  onClose,
}: {
  open: boolean;
  files: PickedFile[];
  current: string | null;
  onFiles: (list: FileList | File[]) => void;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
  onGithubLoad: (file: GithubLoaded) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<"local" | "github">("local");
  const [ghUrl, setGhUrl] = useState(() => {
    try {
      return localStorage.getItem("cr-gh-url") || "";
    } catch {
      return "";
    }
  });
  const [ghLoading, setGhLoading] = useState(false);
  const [ghBusy, setGhBusy] = useState("");
  const [ghErr, setGhErr] = useState("");
  const [ghTree, setGhTree] = useState<GhTree | null>(null);
  const [ghQuery, setGhQuery] = useState("");
  const [ghCodeOnly, setGhCodeOnly] = useState(true);

  const shown = useMemo(() => {
    if (!ghTree) return [];
    const q = ghQuery.trim().toLowerCase();
    return ghTree.files.filter((f) => {
      if (ghCodeOnly && f.kind !== "code") return false;
      if (q && f.path.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }, [ghTree, ghQuery, ghCodeOnly]);

  if (!open) return null;

  async function pull() {
    const target = ghUrl.trim();
    if (!target) {
      setGhErr("先粘贴一个 GitHub 地址");
      return;
    }
    setGhLoading(true);
    setGhErr("");
    setGhTree(null);
    try {
      const r = await fetch("/api/github/tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const j = await r.json();
      if (!r.ok) {
        setGhErr(j.message || "读取仓库失败");
        return;
      }
      if (j.mode === "file" && j.file) {
        onGithubLoad(j.file);
        return;
      }
      setGhTree(j as GhTree);
      try {
        localStorage.setItem("cr-gh-url", target);
      } catch {
        /* ignore */
      }
    } catch {
      setGhErr("接口不通，检查 api 服务是否在运行");
    } finally {
      setGhLoading(false);
    }
  }

  async function openFile(f: GhItem) {
    if (!ghTree || ghBusy) return;
    setGhBusy(f.path);
    setGhErr("");
    try {
      const r = await fetch("/api/github/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: ghTree.repo.owner,
          repo: ghTree.repo.repo,
          ref: ghTree.repo.ref,
          path: f.path,
          sha: f.sha,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setGhErr(j.message || "取文件失败");
        return;
      }
      onGithubLoad(j);
    } catch {
      setGhErr("接口不通，取不到文件");
    } finally {
      setGhBusy("");
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="filemodal" onClick={(e) => e.stopPropagation()}>
        <div className="filemodal-head">
          <b>把文件加进来</b>
          <span className="filemodal-sub">选中后直接进左侧代码区，按原流程分析</span>
          <button className="icon-btn" onClick={onClose} title="关闭">×</button>
        </div>

        <div className="ftabs">
          <button className={"ftab" + (tab === "local" ? " on" : "")} onClick={() => setTab("local")}>
            本地文件
          </button>
          <button className={"ftab" + (tab === "github" ? " on" : "")} onClick={() => setTab("github")}>
            GitHub 仓库
          </button>
        </div>

        {tab === "local" ? (
          <>
            <div
              className="dropzone"
              onClick={() => inputRef.current && inputRef.current.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
                <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
              </svg>
              <span>把文件拖到这里，或点击选择</span>
              <em>.py .js .ts .jsx .java .txt .md .json .csv .sql，可多选</em>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".py,.js,.jsx,.ts,.tsx,.java,.txt,.md,.json,.csv,.sql,.html,.css,.yml,.yaml,.xml"
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length) onFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            <div className="filelist">
              {files.length === 0 ? (
                <div className="pane-empty">
                  <span>还没有文件</span>
                  <span>加进来的文件会留在这个列表里，随时切换</span>
                </div>
              ) : (
                files.map((f) => (
                  <div className={"fitem" + (current === f.name ? " on" : "")} key={f.id} onClick={() => onPick(f.id)}>
                    <div className="fitem-main">
                      <b>{f.name}</b>
                      <span>
                        {f.language} · {(f.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                    <button
                      className="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(f.id);
                      }}
                    >
                      移除
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <div className="gh-row">
              <input
                className="gh-input"
                type="text"
                spellCheck={false}
                value={ghUrl}
                placeholder="https://github.com/owner/repo"
                onChange={(e) => setGhUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") pull();
                }}
              />
              <button className="primary" disabled={ghLoading} onClick={pull}>
                {ghLoading ? "读取中…" : "载入"}
              </button>
            </div>
            <div className="gh-hint">
              支持仓库首页、<code>/tree/分支/目录</code>、<code>/blob/分支/文件</code>；
              自动跳过 node_modules、构建产物和二进制文件
              {ghTree && !ghTree.token ? "（未配 GITHUB_TOKEN，匿名每小时 60 次）" : ""}
            </div>

            {ghErr ? <div className="gh-err">{ghErr}</div> : null}

            {ghTree ? (
              <>
                <div className="gh-repo">
                  <b>
                    {ghTree.repo.owner}/{ghTree.repo.repo}
                  </b>
                  <span className="gh-badge">{ghTree.repo.ref}</span>
                  {ghTree.repo.private ? <span className="gh-badge warn">私有</span> : null}
                  <span className="gh-dim">
                    {ghTree.total} 个可读文件
                    {ghTree.path ? " · " + ghTree.path : ""}
                    {ghTree.skipped ? " · 已跳过 " + ghTree.skipped : ""}
                  </span>
                </div>

                <div className="gh-tools">
                  <input
                    className="gh-search"
                    type="text"
                    spellCheck={false}
                    value={ghQuery}
                    placeholder="搜索文件路径…"
                    onChange={(e) => setGhQuery(e.target.value)}
                  />
                  <label className="gh-check">
                    <input type="checkbox" checked={ghCodeOnly} onChange={(e) => setGhCodeOnly(e.target.checked)} />
                    只看可直接分析
                  </label>
                </div>

                <div className="filelist">
                  {shown.length === 0 ? (
                    <div className="pane-empty">
                      <span>没有匹配的文件</span>
                      <span>换个关键词，或取消「只看可直接分析」</span>
                    </div>
                  ) : (
                    shown.map((f) => (
                      <div
                        className={"fitem gh-fitem" + (ghBusy === f.path ? " on" : "")}
                        key={f.path}
                        onClick={() => openFile(f)}
                        title={f.path}
                      >
                        <div className="fitem-main">
                          <b>{f.path}</b>
                          <span>
                            {f.language} · {(f.size / 1024).toFixed(1)} KB
                            {f.kind === "text" ? " · 按 Python 规则分析" : ""}
                          </span>
                        </div>
                        <span className="gh-go">{ghBusy === f.path ? "载入中…" : "分析 →"}</span>
                      </div>
                    ))
                  )}
                </div>
                {ghTree.truncated ? (
                  <div className="gh-hint">仓库文件较多，只列出前 {shown.length} 个，可用 /tree/分支/目录 缩小范围</div>
                ) : null}
              </>
            ) : (
              <div className="pane-empty">
                <span>粘贴一个 GitHub 地址，点「载入」</span>
                <span>也可以直接粘贴某个文件的链接，会跳过列表直接载入</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
