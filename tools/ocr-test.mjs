
import { createWorker } from "tesseract.js";
const t0 = Date.now();
const worker = await createWorker("eng");
const { data } = await worker.recognize("preview/d2-dark.png");
await worker.terminate();
console.log(JSON.stringify({
  ms: Date.now() - t0,
  chars: data.text.length,
  head: data.text.replace(/\s+/g, " ").slice(0, 220),
}));
