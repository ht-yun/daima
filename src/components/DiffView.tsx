import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { diffLines } from "../engine/diff";
import { highlightLines } from "../engine/highlight";
import type { Language } from "../types";

interface Line {
  no: number;
  html: string;
  kind: "same" | "add" | "del";
}

export default function DiffView({
  before,
  after,
  language,
}: {
  before: string;
  after: string;
  language: Language;
}) {
  const [pos, setPos] = useState(50);
  const [info, setInfo] = useState({ ratio: 0, frac: 1, scrollable: false });
  const hDrag = useRef(false);
  const vDrag = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => diffLines(before, after), [before, after]);
  const oldHtml = useMemo(() => highlightLines(before, language), [before, language]);
  const newHtml = useMemo(() => highlightLines(after, language), [after, language]);

  const oldLines = useMemo<Line[]>(() => {
    const changed = new Set<number>();
    for (const r of rows) if (r.type === "del" && r.oldNo) changed.add(r.oldNo);
    return before.split("\n").map((_, i) => ({
      no: i + 1,
      html: oldHtml[i] || "",
      kind: changed.has(i + 1) ? "del" : "same",
    }));
  }, [before, rows, oldHtml]);

  const newLines = useMemo<Line[]>(() => {
    const changed = new Set<number>();
    for (const r of rows) if (r.type === "add" && r.newNo) changed.add(r.newNo);
    return after.split("\n").map((_, i) => ({
      no: i + 1,
      html: newHtml[i] || "",
      kind: changed.has(i + 1) ? "add" : "same",
    }));
  }, [after, rows, newHtml]);

  const adds = rows.filter((r) => r.type === "add").length;
  const dels = rows.filter((r) => r.type === "del").length;

  const syncScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const frac = el.scrollHeight > 0 ? Math.min(1, el.clientHeight / el.scrollHeight) : 1;
    setInfo({ ratio: max > 4 ? el.scrollTop / max : 0, frac, scrollable: max > 4 });
  }, []);

  useEffect(() => {
    syncScroll();
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncScroll());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncScroll, oldLines.length, newLines.length]);

  function moveTo(clientX: number) {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const p = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.max(18, Math.min(82, p)));
  }

  function onHDown(e: ReactPointerEvent<HTMLDivElement>) {
    hDrag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onHMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!hDrag.current) return;
    moveTo(e.clientX);
  }
  function onHUp(e: ReactPointerEvent<HTMLDivElement>) {
    hDrag.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function scrollFrom(clientY: number) {
    const box = boxRef.current;
    const rail = railRef.current;
    if (!box || !rail) return;
    const rect = rail.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const max = box.scrollHeight - box.clientHeight;
    box.scrollTop = r * max;
    syncScroll();
  }

  function onVDown(e: ReactPointerEvent<HTMLDivElement>) {
    vDrag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrollFrom(e.clientY);
  }
  function onVMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!vDrag.current) return;
    scrollFrom(e.clientY);
  }
  function onVUp(e: ReactPointerEvent<HTMLDivElement>) {
    vDrag.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  if (!before) {
    return (
      <div className="pane-empty">
        <span>还没有可对比的版本</span>
        <span>先跑一次检查，再点「修复」</span>
      </div>
    );
  }

  const thumbTop = info.ratio * (1 - info.frac) * 100;
  const thumbH = Math.max(info.frac * 100, 6);

  return (
    <>
      <div className="dhead">
        <span>共 +{adds} / −{dels} 行</span>
        <span style={{ opacity: 0.6 }}>竖条切左右，右侧细条上下浏览</span>
      </div>

      <div className="splitwrap">
        <div className="splitbox" ref={boxRef} onScroll={syncScroll}>
          <div className="splitrow">
            <div className="spane" style={{ width: pos + "%" }}>
              <div className="spane-head">原代码</div>
              {oldLines.map((l) => (
                <div className={"sline " + l.kind} key={"o" + l.no}>
                  <span className="sno">{l.no}</span>
                  <span className="scode hljs" dangerouslySetInnerHTML={{ __html: l.html }} />
                </div>
              ))}
            </div>

            <div
              className="shandle"
              onPointerDown={onHDown}
              onPointerMove={onHMove}
              onPointerUp={onHUp}
              title="拖动切换左右"
            >
              <span className="shandle-grip" />
            </div>

            <div className="spane" style={{ width: 100 - pos + "%" }}>
              <div className="spane-head after">修复后</div>
              {newLines.map((l) => (
                <div className={"sline " + l.kind} key={"n" + l.no}>
                  <span className="sno">{l.no}</span>
                  <span className="scode hljs" dangerouslySetInnerHTML={{ __html: l.html }} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {info.scrollable ? (
          <div
            className="vrail"
            ref={railRef}
            onPointerDown={onVDown}
            onPointerMove={onVMove}
            onPointerUp={onVUp}
            title="上下拖动浏览"
          >
            <div className="vthumb" style={{ top: thumbTop + "%", height: thumbH + "%" }} />
          </div>
        ) : null}
      </div>

      <div className="split-ctl">
        <span className="split-label">原代码</span>
        <input
          className="split-range"
          type="range"
          min={18}
          max={82}
          step={1}
          value={Math.round(pos)}
          onChange={(e) => setPos(Number(e.target.value))}
        />
        <span className="split-label right">修复后</span>
      </div>
    </>
  );
}
