import { useEffect, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { highlightLines } from "../engine/highlight";
import type { Language } from "../types";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function renderMarkdown(text: string): string {
  try {
    return md.render(text);
  } catch {
    return text.replace(/</g, "&lt;");
  }
}

type Role = "user" | "assistant";
interface Msg {
  role: Role;
  content: string;
  images?: string[];
}

interface Block {
  type: "text" | "code";
  lang: string;
  content: string;
}

function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let mode: "text" | "code" = "text";
  let lang = "";
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (mode === "text") {
        if (buf.length) out.push({ type: "text", lang: "", content: buf.join("\n") });
        buf = [];
        mode = "code";
        lang = line.trim().slice(3).trim();
      } else {
        out.push({ type: "code", lang, content: buf.join("\n") });
        buf = [];
        mode = "text";
      }
      continue;
    }
    buf.push(line);
  }
  if (buf.length) out.push({ type: mode, lang, content: buf.join("\n") });
  return out;
}

function langOf(name: string, fallback: Language): Language {
  const n = name.toLowerCase();
  if (n.startsWith("py")) return "python";
  if (n.startsWith("js") || n.startsWith("ts") || n.startsWith("javascript") || n.startsWith("typescript")) return "javascript";
  if (n.startsWith("java")) return "java";
  return fallback;
}

function CodeBlock({ code, lang, onApply }: { code: string; lang: Language; onApply: (c: string) => void }) {
  const html = highlightLines(code, lang).join("\n");
  return (
    <div className="codeblock">
      <div className="cb-head">
        <span>{lang}</span>
        <button className="ghost" onClick={() => onApply(code)}>应用到编辑器</button>
      </div>
      <pre className="cb-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function writeStr(dv: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i += 1) dv.setUint8(offset + i, s.charCodeAt(i));
}

function encodeWavBase64(buffer: AudioBuffer, targetRate: number): string {
  const src = buffer.getChannelData(0);
  const ratio = buffer.sampleRate / targetRate;
  const len = Math.max(1, Math.floor(src.length / ratio));
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i += 1) {
    const s = src[Math.floor(i * ratio)] || 0;
    pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  writeStr(dv, 0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(dv, 8, "WAVE");
  writeStr(dv, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, targetRate, true);
  dv.setUint32(28, targetRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(dv, 36, "data");
  dv.setUint32(40, pcm.length * 2, true);

  const bytes = new Uint8Array(44 + pcm.length * 2);
  bytes.set(new Uint8Array(header), 0);
  bytes.set(new Uint8Array(pcm.buffer), 44);

  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

export default function ChatPanel({
  code,
  language,
  onApply,
}: {
  code: string;
  language: Language;
  onApply: (c: string) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const seededRef = useRef(false);
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  function pickImage(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImages((prev) => [...prev, String(reader.result || "")].slice(0, 3));
      setHint("图片已附上，发出去会交给千问的视觉模型");
    };
    reader.readAsDataURL(file);
  }

  if (import.meta.env.DEV) {
    (window as any).__pickImage = pickImage;
  }

  async function transcribe(blob: Blob) {
    setHint("正在转写…");
    try {
      const buf = await blob.arrayBuffer();
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const audioBuf: AudioBuffer = await ctx.decodeAudioData(buf);
      const b64 = encodeWavBase64(audioBuf, 16000);
      try { await ctx.close(); } catch { /* ignore */ }
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: b64, format: "wav" }),
      });
      const j = await res.json();
      if (!res.ok) {
        setHint(j.message || "转写失败");
        return;
      }
      setInput((prev) => (prev ? prev + " " : "") + String(j.text || "").trim());
      setHint("转写完成，改一改再发送");
    } catch (err) {
      setHint("转写失败：" + String((err as Error).message || err).slice(0, 60));
    }
  }

  async function toggleVoice() {
    if (recording) {
      try { recRef.current && recRef.current.rec.stop(); } catch { /* ignore */ }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size > 800) await transcribe(blob);
        else setHint("录音太短，再说一次");
      };
      rec.start();
      recRef.current = { rec, stream };
      setRecording(true);
      setHint("正在录音…再点一下麦克风结束");
    } catch (err) {
      setHint("用不了麦克风：" + String((err as Error).message || err).slice(0, 60));
    }
  }

  async function send(text: string) {
    const question = text.trim();
    if ((!question && images.length === 0) || busy) return;
    const attached = images;
    setInput("");
    setImages([]);
    setHint("");
    const next: Msg[] = [...messages, { role: "user", content: question, images: attached }, { role: "assistant", content: "" }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
          code,
          language,
          images: attached,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: "assistant", content: "对话失败：" + ((j && j.message) || res.status) };
          return copy;
        });
        setBusy(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.text) {
              acc += j.text;
              setMessages((m) => {
                const copy = m.slice();
                copy[copy.length - 1] = { role: "assistant", content: acc };
                return copy;
              });
            }
            if (j.error) acc += "\n\n[出错了：" + j.error + "]";
          } catch { /* ignore */ }
        }
      }
    } catch {
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: "assistant", content: "网络异常，请重试" };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const ask = new URLSearchParams(location.search).get("ask");
    if (ask) setTimeout(() => send(ask), 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chips = ["这段代码最大的风险是什么？", "为什么第 7 行不安全？", "改成参数化查询怎么写？"];

  return (
    <div
      className="chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) pickImage(f);
      }}
    >
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="pane-empty">
            <span>问问这段代码，或者发张截图</span>
            <span>文字走 DeepSeek，图片和语音走千问</span>
          </div>
        ) : (
          messages.map((m, i) => (
            <div className={"msg " + m.role} key={i}>
              {m.role === "assistant" ? <div className="mini-avatar">审</div> : null}
              <div className="bubble">
                {m.images && m.images.length ? (
                  <div className="thumbs">
                    {m.images.map((src, k) => <img src={src} key={k} alt="attachment" />)}
                  </div>
                ) : null}
                {m.content
                  ? parseBlocks(m.content).map((b, k) =>
                      b.type === "code" ? (
                        <CodeBlock key={k} code={b.content} lang={langOf(b.lang, language)} onApply={onApply} />
                      ) : (
                        <div key={k} className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.content) }} />
                      )
                    )
                  : busy && i === messages.length - 1
                    ? <span className="typing">正在思考…</span>
                    : null}
              </div>
            </div>
          ))
        )}
      </div>

      {images.length ? (
        <div className="attach-row">
          {images.map((src, i) => (
            <div className="thumb" key={i}>
              <img src={src} alt="待发送图片" />
              <button onClick={() => setImages((prev) => prev.filter((_, k) => k !== i))}>×</button>
            </div>
          ))}
        </div>
      ) : null}

      {hint ? <div className="chat-hint">{hint}</div> : null}

      <div className="chat-input">
        <div className="chat-tools">
          <button className="iconbtn" title="发图片（也可直接粘贴截图）" onClick={() => fileRef.current && fileRef.current.click()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9.5" r="1.5" />
              <path d="m21 16-5-5L5 20" />
            </svg>
          </button>
          <button className={"iconbtn" + (recording ? " rec" : "")} title="语音输入" onClick={toggleVoice}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) pickImage(f);
            e.target.value = "";
          }}
        />
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder={recording ? "正在录音…" : "问点什么，Enter 发送；可粘贴截图或按住说话"}
          onPaste={(e) => {
            const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
            if (item) {
              const f = item.getAsFile();
              if (f) {
                e.preventDefault();
                pickImage(f);
              }
            }
          }}
          rows={1}
        />
        <button className="send-btn" disabled={busy || (!input.trim() && images.length === 0)} onClick={() => send(input)}>
          {busy ? "…" : "↑"}
        </button>
      </div>

      {messages.length === 0 && images.length === 0 ? (
        <div className="chips">
          {chips.map((c) => (
            <button className="fchip" key={c} onClick={() => send(c)}>{c}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
