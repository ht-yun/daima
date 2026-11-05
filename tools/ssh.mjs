import { Client } from "ssh2";
import { readFileSync, writeFileSync } from "node:fs";

const [, , mode, a, b] = process.argv;
const cfg = {
  host: "127.0.0.1",
  port: 22,
  username: "hxy5555555558888",
  password: process.env.SSH_PASS,
  readyTimeout: 25000,
};

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => resolve(conn)).on("error", reject);
    conn.connect(cfg);
  });
}

function run(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let errOut = "";
      stream.on("data", (d) => { out += d; });
      stream.stderr.on("data", (d) => { errOut += d; });
      stream.on("close", (code) => resolve({ code, out, errOut }));
    });
  });
}

const conn = await connect();

if (mode === "run") {
  const r = await run(conn, a);
  console.log(JSON.stringify({ code: r.code, out: r.out.slice(-3000), err: r.errOut.slice(-1500) }));
} else if (mode === "put") {
  await new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(a, b, (e) => (e ? reject(e) : resolve(null)));
    });
  });
  console.log(JSON.stringify({ ok: true, put: b }));
}

conn.end();
