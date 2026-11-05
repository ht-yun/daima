import type { Issue, Scores } from "../types";
import { DIMENSIONS, DIM_LABEL } from "../types";
import { computeScores, average } from "../engine/score";

type Hist = { id: string; at: number; name: string; issues: Issue[] };

interface Props {
  user: string;
  scores: Scores;
  issues: Issue[];
  history: Hist[];
  fileName: string | null;
  onDesk: () => void;
  onAlert: () => void;
  onImport: () => void;
  onGithub: () => void;
  onRules: () => void;
  onLogs: () => void;
  onHistory: () => void;
}

const CX = 70;
const CY = 68;
const R = 46;
const ANG = [-90, -18, 54, 126, 198];

function pt(i: number, r: number) {
  const a = (ANG[i] * Math.PI) / 180;
  return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
}

function poly(rs: number[]) {
  return rs.map((r, i) => {
    const p = pt(i, r);
    return p.x.toFixed(1) + "," + p.y.toFixed(1);
  }).join(" ");
}

const Icon = ({ d }: { d: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export default function Overview(p: Props) {
  const highs = p.issues.filter((i) => i.severity === "high");
  const mids = p.issues.filter((i) => i.severity === "mid");
  const score = p.issues.length || p.fileName ? average(p.scores) : null;

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const weekCount = p.history.filter((h) => h.at >= weekAgo).length;
  const files = new Set(p.history.map((h) => h.name)).size;

  const trend = p.history.slice(0, 5).map((h) => average(computeScores(h.issues))).reverse();
  const trendPts = trend.length >= 2
    ? trend.map((v, i) => {
        const x = 14 + (i * 208) / Math.max(1, trend.length - 1);
        const y = 56 - (v / 100) * 46;
        return { x, y, v };
      })
    : [];

  const ringRatios = [1, 0.66, 0.33, 0.12].map((k) => DIMENSIONS.map(() => R * k));
  const dataRatios = DIMENSIONS.map((d) => (Math.max(0, Math.min(100, p.scores[d])) / 100) * R);
  const topAlert = highs[0] || mids[0] || null;

  return (
    <div className="ov">
      <div className="ov-hello">
        <div>
          <h1>你好，{p.user || "开发者"}</h1>
          <p>
            {highs.length > 0
              ? `今天有 ${highs.length} 个高危问题待处理`
              : p.issues.length > 0
              ? `当前文件有 ${p.issues.length} 个问题，暂无高危`
              : "还没有开始检查，导入代码就能看到结果"}
            {score !== null ? `，最近一次评分 ${score} 分` : ""}
          </p>
        </div>
        <button className="ov-go" onClick={p.onDesk}>进入审阅台</button>
      </div>

      <div className="ov-stats">
        <div className="ov-card ov-stat">
          <span className="ov-label">健康评分</span>
          <b className="ov-num">{score === null ? "—" : score}</b>
          <span className="ov-sub">{score === null ? "尚未检查" : score >= 80 ? "整体良好" : score >= 60 ? "有改进空间" : "问题较集中"}</span>
        </div>
        <div className="ov-card ov-stat">
          <span className="ov-label">已审文件</span>
          <b className="ov-num">{files}</b>
          <span className="ov-sub">历史记录 {p.history.length} 次</span>
        </div>
        <div className="ov-card ov-stat">
          <span className="ov-label">问题总数</span>
          <b className="ov-num">{p.issues.length}</b>
          <span className="ov-sub">高危 {highs.length} · 中危 {mids.length}</span>
        </div>
        <div className="ov-card ov-stat">
          <span className="ov-label">本周检查</span>
          <b className="ov-num">{weekCount}</b>
          <span className="ov-sub">{p.fileName ? "当前：" + p.fileName : "本周新增"}</span>
        </div>
      </div>

      <div className="ov-row ov-row2">
        <div className="ov-card">
          <div className="ov-head">
            <span>代码健康</span>
            <em>五个维度</em>
          </div>
          <svg viewBox="0 0 140 132" className="ov-radar">
            {ringRatios.map((rs, k) => (
              <polygon key={k} points={poly(rs)} fill="none" stroke="var(--line)" strokeWidth={k === 0 ? 1 : 0.8} opacity={k === 0 ? 1 : 0.7} />
            ))}
            {DIMENSIONS.map((d, i) => {
              const e = pt(i, R);
              return <line key={d} x1={CX} y1={CY} x2={e.x} y2={e.y} stroke="var(--line)" strokeWidth="0.8" />;
            })}
            <polygon points={poly(dataRatios)} fill="var(--accent)" fillOpacity="0.16" stroke="var(--accent)" strokeWidth="1.4" />
            {dataRatios.map((r, i) => {
              const q = pt(i, r);
              return <circle key={i} cx={q.x} cy={q.y} r="2" fill="var(--accent)" />;
            })}
            {DIMENSIONS.map((d, i) => {
              const q = pt(i, R + 15);
              return (
                <text key={d} x={q.x} y={q.y + 3} textAnchor="middle" fontSize="9.5" fill="var(--muted)">
                  {DIM_LABEL[d]}
                </text>
              );
            })}
          </svg>
          <div className="ov-legend">
            {DIMENSIONS.map((d) => (
              <span key={d}>
                <i>{p.scores[d]}</i>
                {DIM_LABEL[d]}
              </span>
            ))}
          </div>
        </div>

        <div className="ov-card">
          <div className="ov-head">
            <span>最近审查</span>
            <button className="ov-link" onClick={p.onHistory}>全部</button>
          </div>
          {p.history.length === 0 ? (
            <div className="ov-empty">还没有记录，检查一次就会出现在这里</div>
          ) : (
            <div className="ov-list">
              {p.history.slice(0, 3).map((h) => (
                <div key={h.id} className="ov-item">
                  <span className="ov-dot" />
                  <div>
                    <b title={h.name}>{h.name}</b>
                    <em>{average(computeScores(h.issues))} 分 · {new Date(h.at).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</em>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={"ov-card ov-alert" + (topAlert ? " on" : "")}>
          <div className="ov-head">
            <span>风险预警</span>
          </div>
          {topAlert ? (
            <>
              <b className="ov-alert-t">{topAlert.severity === "high" ? "检测到高危问题" : "有待处理的中危问题"}</b>
              <p className="ov-alert-d" title={topAlert.title}>{topAlert.title}</p>
              <span className="ov-alert-m">第 {topAlert.line} 行 · {DIM_LABEL[topAlert.dimension]}</span>
              <button className="ov-link ov-alert-b" onClick={p.onAlert}>去处理</button>
            </>
          ) : (
            <div className="ov-empty">当前没有需要处理的预警</div>
          )}
        </div>
      </div>

      <div className="ov-row ov-row3">
        <div className="ov-card">
          <div className="ov-head">
            <span>评分趋势</span>
            <em>{trend.length >= 2 ? "最近 " + trend.length + " 次" : "需要至少两次记录"}</em>
          </div>
          {trendPts.length >= 2 ? (
            <svg viewBox="0 0 236 64" className="ov-trend">
              <line x1="6" y1="56" x2="230" y2="56" stroke="var(--line)" />
              <polyline points={trendPts.map((t) => t.x + "," + t.y).join(" ")} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
              {trendPts.map((t, i) => (
                <circle key={i} cx={t.x} cy={t.y} r={i === trendPts.length - 1 ? 2.6 : 2.1} fill={i === trendPts.length - 1 ? "var(--accent)" : "var(--card)"} stroke="var(--accent)" strokeWidth="1.4" />
              ))}
              {trendPts.map((t, i) =>
                i === 0 || i === trendPts.length - 1 ? (
                  <text key={"t" + i} x={t.x} y={t.y - 6} textAnchor="middle" fontSize="9" fill="var(--muted)">{t.v}</text>
                ) : null
              )}
            </svg>
          ) : (
            <div className="ov-ph">多检查几次，这里会显示评分变化</div>
          )}
        </div>

        <div className="ov-card">
          <div className="ov-head">
            <span>快捷入口</span>
          </div>
          <div className="ov-quick">
            <button onClick={p.onImport}><Icon d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /><span>本地文件</span></button>
            <button onClick={p.onGithub}><Icon d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 4.5-1.4 4.5-4.8 0-1-.3-1.9-1-2.6.3-.9.3-1.9-.1-2.8 0 0-1.5-.5-4.5 1.2a12 12 0 0 0-6 0C5.4 2.8 3.9 3.3 3.9 3.3c-.4.9-.4 1.9-.1 2.8-.7.7-1 1.6-1 2.6 0 3.4 1.7 4.5 4.5 4.8-.4.4-.5.9-.5 1.5V20" /><span>GitHub</span></button>
            <button onClick={p.onRules}><Icon d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" /><span>规则模板</span></button>
            <button onClick={p.onLogs}><Icon d="M4 5h16v14H4zM7 9l2.5 2L7 13M12 13h4" /><span>运行日志</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}
