import { useMemo, useState } from "react";
import { RULE_META } from "../engine/rules";
import { DIM_LABEL, SEV_LABEL } from "../types";
import type { Dimension } from "../types";

const ORDER: Dimension[] = ["security", "logic", "performance", "syntax", "style"];

const PRESETS: { key: string; label: string; keep: (id: string) => boolean }[] = [
  { key: "all", label: "全部启用", keep: () => true },
  { key: "sec", label: "安全基线", keep: (id) => id.startsWith("SEC") },
  { key: "clean", label: "代码整洁", keep: (id) => /^(STY|SYN|LOG)/.test(id) },
  { key: "perf", label: "性能优先", keep: (id) => /^(PER|SEC)/.test(id) },
];

interface Props {
  open: boolean;
  off: string[];
  favs: string[];
  onlyFavs: boolean;
  favOnly: boolean;
  onChange: (next: string[]) => void;
  onFavs: (next: string[]) => void;
  onOnlyFavs: (v: boolean) => void;
  onFavOnly: (v: boolean) => void;
  onClose: () => void;
}

export default function RulesPanel({
  open,
  off,
  favs,
  onlyFavs,
  favOnly,
  onChange,
  onFavs,
  onOnlyFavs,
  onFavOnly,
  onClose,
}: Props) {
  const [q, setQ] = useState("");
  const offSet = useMemo(() => new Set(off), [off]);
  const favSet = useMemo(() => new Set(favs), [favs]);
  if (!open) return null;

  const total = RULE_META.length;
  const enabled = total - offSet.size;

  const filtered = RULE_META.filter((r) => {
    if (favOnly && !favSet.has(r.id)) return false;
    if (!q.trim()) return true;
    return r.title.includes(q.trim()) || r.id.toLowerCase().includes(q.trim().toLowerCase());
  });

  function toggle(id: string) {
    const next = new Set(offSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }

  function toggleFav(id: string) {
    onFavs(favSet.has(id) ? favs.filter((x) => x !== id) : [...favs, id]);
  }

  function applyPreset(keep: (id: string) => boolean) {
    onChange(RULE_META.filter((r) => !keep(r.id)).map((r) => r.id));
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="rulesmodal" onClick={(e) => e.stopPropagation()}>
        <div className="rules-head">
          <b>{favOnly ? "收藏规则" : "规则模板"}</b>
          <span className="rules-sub">
            已启用 <b className="rules-count">{enabled}</b> / {total}
          </span>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <div className="rules-tools">
          <input
            className="rules-search"
            value={q}
            placeholder="搜索规则名或编号"
            onChange={(e) => setQ(e.target.value)}
          />
          <button className={"fchip" + (favOnly ? " on" : "")} onClick={() => onFavOnly(!favOnly)}>
            只看收藏 {favs.length}
          </button>
          {PRESETS.map((p) => (
            <button className="fchip" key={p.key} onClick={() => applyPreset(p.keep)}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="rules-list">
          {filtered.length === 0 ? (
            <div className="pane-empty">
              <span>{favOnly ? "还没有收藏的规则" : "没有匹配的规则"}</span>
              <span>{favOnly ? "在规则模板里点左边的星标收藏" : "换个关键词试试"}</span>
            </div>
          ) : null}
          {ORDER.map((dim) => {
            const items = filtered.filter((r) => r.dimension === dim);
            if (!items.length) return null;
            return (
              <div key={dim} className="rules-group">
                <div className="rules-group-head">
                  <span>{DIM_LABEL[dim]}</span>
                  <em>{items.length} 条</em>
                </div>
                {items.map((r) => {
                  const on = !offSet.has(r.id);
                  const fav = favSet.has(r.id);
                  return (
                    <div className={"rule-row" + (on ? "" : " off")} key={r.id} onClick={() => toggle(r.id)}>
                      <button
                        className={"rule-star" + (fav ? " on" : "")}
                        title={fav ? "取消收藏" : "收藏"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFav(r.id);
                        }}
                      >
                        {fav ? "★" : "☆"}
                      </button>
                      <span className={"rule-sw" + (on ? " on" : "")}>
                        <i />
                      </span>
                      <span className="rule-id">{r.id}</span>
                      <span className="rule-title">{r.title}</span>
                      <span className={"tag " + (r.severity === "high" ? "high" : r.severity === "mid" ? "mid" : "low")}>
                        {SEV_LABEL[r.severity]}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="rules-foot">
          <label className="rules-onlyfav">
            <input type="checkbox" checked={onlyFavs} disabled={favs.length === 0} onChange={(e) => onOnlyFavs(e.target.checked)} />
            只跑收藏的规则（{favs.length} 条）
          </label>
          <span>关掉的规则不参与扫描、不计入风险评分；改动在下次分析时生效。</span>
        </div>
      </div>
    </div>
  );
}
