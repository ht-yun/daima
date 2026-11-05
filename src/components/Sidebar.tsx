interface NavItem {
  key: string;
  label: string;
  d: string;
  action?: boolean;
}

const I = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const ITEMS: NavItem[] = [
  { key: "overview", label: "概览", d: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" },
  { key: "desk", label: "审阅台", d: "M4 5h16v14H4zM8 9l3 3-3 3M13 15h4" },
  { key: "archive", label: "档案库", d: "M4 7h16v13H4zM4 7l2-3h12l2 3M9 12h6", action: true },
  { key: "search", label: "全局检索", d: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3" },
  { key: "settings", label: "设置", d: "M4 8h10M18 8h2M4 16h4M12 16h8M16 5v6M8 13v6" },
];

export default function Sidebar({
  active,
  onNav,
}: {
  active: string;
  onNav: (key: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="logo">审</div>
        <div className="sidebar-brand-text">
          <b>码审</b>
          <span>CodeReview</span>
        </div>
      </div>
      <nav className="sidebar-nav">
        {ITEMS.map((it) => (
          <button
            key={it.key}
            className={"navitem" + (active === it.key ? " on" : "")}
            onClick={() => onNav(it.key)}
            title={it.label}
          >
            <span className="navicon">{I(it.d)}</span>
            <span className="navlabel">{it.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">v0.3 · 本地部署</div>
    </aside>
  );
}
