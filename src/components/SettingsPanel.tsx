import { useRef } from "react";
import type { RainLevel } from "./MatrixRain";

export interface Prefs {
  nickname: string;
  avatar: string;
  retry: number;
  verbose: boolean;
  rain: boolean;
  rainLevel: RainLevel;
}

interface Props {
  open: boolean;
  cfg: { hasKey: boolean; model: string; baseUrl?: string; mock?: boolean } | null;
  auth: { required: boolean; authed: boolean; user?: string | null } | null;
  prefs: Prefs;
  theme: "dark" | "light";
  onClose: () => void;
  onSaveModel: (patch: { baseUrl: string; model: string; apiKey: string }) => Promise<void>;
  onPrefs: (patch: Partial<Prefs>) => void;
  onTheme: (t: "dark" | "light") => void;
  onLogout: () => void;
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="set-section">
      <div className="set-head">
        <b>{title}</b>
        {desc ? <span>{desc}</span> : null}
      </div>
      {children}
    </div>
  );
}

export default function SettingsPanel({
  open,
  cfg,
  auth,
  prefs,
  theme,
  onClose,
  onSaveModel,
  onPrefs,
  onTheme,
  onLogout,
}: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <b>设置</b>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-body">
          <Section title="个人信息" desc="头像和昵称只保存在这台电脑上">
            <div className="profile-row">
              <div
                className="avatar avatar-lg"
                onClick={() => fileRef.current && fileRef.current.click()}
                title="点击更换头像"
              >
                {prefs.avatar ? <img src={prefs.avatar} alt="" /> : <span>{(prefs.nickname || auth?.user || "L").slice(0, 1).toUpperCase()}</span>}
              </div>
              <div className="profile-fields">
                <input
                  value={prefs.nickname}
                  placeholder="昵称"
                  onChange={(e) => onPrefs({ nickname: e.target.value })}
                />
                <div className="profile-actions">
                  <button className="ghost" onClick={() => fileRef.current && fileRef.current.click()}>更换头像</button>
                  {prefs.avatar ? <button className="ghost" onClick={() => onPrefs({ avatar: "" })}>移除</button> : null}
                </div>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (!f) return;
                  if (f.size > 400 * 1024) return;
                  const reader = new FileReader();
                  reader.onload = () => onPrefs({ avatar: String(reader.result || "") });
                  reader.readAsDataURL(f);
                  e.target.value = "";
                }}
              />
            </div>
          </Section>

          <Section title="账号权限" desc="账号由服务器 .env 的 APP_USERS 配置">
            <div className="kv"><span>登录账号</span><b>{auth && auth.user ? auth.user : "未登录"}</b></div>
            <div className="kv"><span>角色</span><b>管理员</b></div>
            <div className="kv"><span>会话</span><b>HttpOnly Cookie · 7 天</b></div>
            <div className="kv"><span>模型调用</span><b>{cfg && cfg.hasKey ? "已授权" : "未配置"}</b></div>
            <div className="set-actions">
              <button className="ghost danger" onClick={onLogout}>退出登录</button>
            </div>
          </Section>

          <Section title="异常处理" desc="接口失败时的行为">
            <div className="kv">
              <span>自动重试</span>
              <select
                className="select"
                value={prefs.retry}
                onChange={(e) => onPrefs({ retry: Number(e.target.value) })}
              >
                <option value={0}>不重试</option>
                <option value={1}>重试 1 次</option>
                <option value={2}>重试 2 次</option>
              </select>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.verbose}
                onChange={(e) => onPrefs({ verbose: e.target.checked })}
              />
              <span>显示详细错误信息</span>
            </label>
          </Section>

          <Section title="外观" desc="深色适合长时间看代码">
            <div className="theme-row">
              <button className={"theme-card" + (theme === "dark" ? " on" : "")} onClick={() => onTheme("dark")}>
                <span className="theme-preview dark" />
                深色
              </button>
              <button className={"theme-card" + (theme === "light" ? " on" : "")} onClick={() => onTheme("light")}>
                <span className="theme-preview light" />
                浅色
              </button>
            </div>
            <div className={"rain-row" + (theme === "dark" ? "" : " off")}>
              <div className="rain-line">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={prefs.rain}
                    disabled={theme !== "dark"}
                    onChange={(e) => onPrefs({ rain: e.target.checked })}
                  />
                  <span>代码雨背景</span>
                </label>
                <em>{theme === "dark" ? "深色主题下的飘落字符" : "仅深色主题可用"}</em>
              </div>
              <div className="rain-levels">
                {([1, 2, 3] as RainLevel[]).map((lv) => (
                  <button
                    key={lv}
                    className={"rain-lv" + (prefs.rainLevel === lv ? " on" : "")}
                    disabled={theme !== "dark" || !prefs.rain}
                    onClick={() => onPrefs({ rainLevel: lv })}
                  >
                    {lv === 1 ? "微弱" : lv === 2 ? "适中" : "明显"}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          <Section title="模型" desc="文本分析走 DeepSeek，图片语音走千问">
            <div className="kv"><span>当前文本模型</span><b>{cfg ? cfg.model : "-"}</b></div>
            <ModelForm cfg={cfg} onSaveModel={onSaveModel} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function ModelForm({
  cfg,
  onSaveModel,
}: {
  cfg: Props["cfg"];
  onSaveModel: Props["onSaveModel"];
}) {
  const baseUrl = (cfg && cfg.baseUrl) || "https://api.deepseek.com/v1";
  const model = (cfg && cfg.model) || "deepseek-chat";
  return (
    <div className="model-form">
      <input defaultValue={baseUrl} id="set-base" placeholder="接口地址" />
      <input defaultValue={model} id="set-model" placeholder="模型名" />
      <input id="set-key" type="password" placeholder="API Key（留空表示不修改）" />
      <button
        className="ghost"
        onClick={() => {
          const g = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value || "";
          onSaveModel({ baseUrl: g("set-base"), model: g("set-model"), apiKey: g("set-key") });
        }}
      >
        保存模型配置
      </button>
    </div>
  );
}
