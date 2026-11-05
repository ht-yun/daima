// 临时运维通道：上传文件 / 执行 PowerShell
import { Client } from "ssh2";
import { readFileSync } from "node:fs";

const HOST = "127.0.0.1";
const USER = "Administrator";
const PASS = process.env.SSH_PASS;
const mode = process.argv[2];
const arg = process.argv[3];

const c = await new Promise((resolve, reject) => {
  const cl = new Client();
  cl.on("ready", () => resolve(cl)).on("error", reject).connect({
    host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000,
  });
});

if (mode === "ps") {
  const b64 = Buffer.from(readFileSync(arg, "utf8"), "utf16le").toString("base64");
  await new Promise((resolve) => {
    c.exec(`powershell -NoProfile -EncodedCommand ${b64}`, (err, stream) => {
      if (err) { console.error(err.message); resolve(); return; }
      stream.on("data", (d) => process.stdout.write(d.toString()));
      stream.stderr.on("data", (d) => process.stderr.write(d.toString()));
      stream.on("close", resolve);
    });
  });
} else if (mode === "put") {
  const dst = process.argv[4];
  await new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) { reject(err); return; }
      sftp.fastPut(arg, dst, (e) => (e ? reject(e) : resolve()));
    });
  }).catch((e) => console.error("put fail", e.message));
}
c.end();
