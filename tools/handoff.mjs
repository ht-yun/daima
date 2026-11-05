import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const API = "http://127.0.0.1:8787";
const APP = "http://127.0.0.1:5173";
const root = path.resolve(import.meta.dirname, "..");
const arg = process.argv[2];

function open(url) {
  console.log("OPEN " + url);
  if (process.env.CR_NO_OPEN === "1") return;
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function log(msg) {
  try {
    mkdirSync(path.join(root, "logs"), { recursive: true });
    writeFileSync(path.join(root, "logs", "handoff.log"), new Date().toISOString() + "  " + msg + "\n", { flag: "a" });
  } catch { /* ignore */ }
}

if (!arg) {
  open(APP);
  process.exit(0);
}

const file = path.resolve(arg);
const name = path.basename(file);
const ext = path.extname(file).toLowerCase();
let content = "";

try {
  if (ext === ".docx") {
    const py = process.env.PYTHON_BIN || "python";
    content = execFileSync(py, ["-c", "import sys, docx; d = docx.Document(sys.argv[1]); print('\\n'.join(p.text for p in d.paragraphs))", file], { encoding: "utf8" });
  } else if ([".txt", ".md", ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".json", ".csv", ".html", ".css", ".sql", ".yml", ".yaml", ".xml"].includes(ext) || ext === "") {
    content = readFileSync(file, "utf8");
  } else {
    log("unsupported ext: " + ext);
    open(APP);
    process.exit(0);
  }
} catch (err) {
  log("read failed: " + String(err && err.message ? err.message : err));
  open(APP);
  process.exit(0);
}

if (!content.trim() || content.includes("\u0000")) {
  log("binary or empty file");
  open(APP);
  process.exit(0);
}

try {
  const res = await fetch(API + "/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content }),
  });
  const data = await res.json();
  log("ingest " + name + " -> " + (data.id || JSON.stringify(data)));
  open(APP + "/?ingest=" + (data.id || ""));
} catch (err) {
  log("api down: " + String(err && err.message ? err.message : err));
  open(APP);
}
