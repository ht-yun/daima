import { useState } from "react";

interface Props {
  open: boolean;
  cfg: { hasKey: boolean; model: string; baseUrl?: string; mock?: boolean } | null;
  onClose: () => void;
  onSave: (patch: { baseUrl: string; model: string; apiKey: string }) => Promise<void>;
}

export default function SettingsModal({ open, cfg, onClose, onSave }: Props) {
  const [baseUrl, setBaseUrl] = useState(cfg && cfg.baseUrl ? cfg.baseUrl : "https://api.deepseek.com/v1");
  const [model, setModel] = useState(cfg && cfg.model ? cfg.model : "deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b style={{ fontSize: 14 }}>模型设置</b>
          <span className="tag-neutral">{cfg && cfg.hasKey ? "已配置" : "未配置 · 演示模式"}</span>
        </div>
        <div className="field">
          <span>接口地址（OpenAI 兼容）</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
        </div>
        <div className="field">
          <span>模型名</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
        </div>
        <div className="field">
          <span>API Key（只写入本机 .env，不会上传）</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onClose}>关闭</button>
          <button
            className="primary"
            style={{ marginLeft: 0 }}
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave({ baseUrl, model, apiKey });
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "保存中…" : "保存并启用"}
          </button>
        </div>
      </div>
    </div>
  );
}
