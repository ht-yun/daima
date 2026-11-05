import { useEffect, useRef, useState } from "react";

export type RainLevel = 1 | 2 | 3;

interface Props {
  level: RainLevel;
}

/**
 * 深色主题的代码雨背景。
 * 两层 canvas：底层静态（天空渐变 + 竖光丝 + 光点 + 暗角），上层字符用
 * destination-out 逐帧淡出，形成自然拖尾，每帧只画新增的字符，开销很低。
 */
const CFG: Record<
  RainLevel,
  {
    tint: [number, number, number];
    head: string;
    glow: number;
    sky: [string, string, string];
    colStep: number;
    fontSize: number;
    fade: number;
    speed: [number, number];
    strands: number;
    bokeh: number;
    vignette: number;
  }
> = {
  1: {
    tint: [76, 240, 138],
    head: "#EDFFF5",
    glow: 10,
    sky: ["#0B2918", "#071710", "#03100A"],
    colStep: 14,
    fontSize: 12,
    fade: 0.155,
    speed: [50, 130],
    strands: 120,
    bokeh: 50,
    vignette: 0.22,
  },
  2: {
    tint: [92, 255, 152],
    head: "#F2FFF8",
    glow: 14,
    sky: ["#0F3520", "#0A2016", "#05120C"],
    colStep: 12,
    fontSize: 12,
    fade: 0.092,
    speed: [55, 155],
    strands: 150,
    bokeh: 70,
    vignette: 0.14,
  },
  3: {
    tint: [116, 255, 170],
    head: "#F7FFFB",
    glow: 16,
    sky: ["#144427", "#0C2A1B", "#07170F"],
    colStep: 12,
    fontSize: 12,
    fade: 0.062,
    speed: [60, 175],
    strands: 180,
    bokeh: 88,
    vignette: 0.08,
  },
};

const KANA = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0testuser9";

export default function MatrixRain({ level }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [allowed, setAllowed] = useState(false);

  // 窄屏和「减少动态效果」下不渲染
  useEffect(() => {
    const mqMobile = window.matchMedia("(max-width: 767px)");
    const mqMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setAllowed(!mqMobile.matches && !mqMotion.matches);
    sync();
    mqMobile.addEventListener("change", sync);
    mqMotion.addEventListener("change", sync);
    return () => {
      mqMobile.removeEventListener("change", sync);
      mqMotion.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const host = hostRef.current;
    if (!host) return;

    const root = document.documentElement;
    root.dataset.rain = "on";

    const cfg = CFG[level];
    const skyCv = document.createElement("canvas");
    const rainCv = document.createElement("canvas");
    skyCv.className = "rain-layer";
    rainCv.className = "rain-layer";
    host.appendChild(skyCv);
    host.appendChild(rainCv);

    const sctx = skyCv.getContext("2d");
    const rctx = rainCv.getContext("2d");
    if (!sctx || !rctx) return;

    let W = 0;
    let H = 0;
    let dpr = 1;
    let cols: { py: number; acc: number; speed: number; hold: number }[] = [];
    let raf = 0;
    let running = true;
    let last = 0;

    const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

    function paintSky() {
      if (!sctx) return;
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, W, H);
      const g = sctx.createRadialGradient(W * 0.5, -H * 0.55, 40, W * 0.5, H * 0.3, W * 1.05);
      g.addColorStop(0, cfg.sky[0]);
      g.addColorStop(0.44, cfg.sky[1]);
      g.addColorStop(1, cfg.sky[2]);
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, W, H);

      // 竖光丝
      for (let i = 0; i < cfg.strands; i += 1) {
        const x = Math.round(Math.random() * W) + 0.5;
        const y0 = Math.random() * H * 1.3 - H * 0.2;
        const len = 40 + Math.random() * 170;
        const a = 0.07 + Math.random() * 0.14;
        const lg = sctx.createLinearGradient(0, y0, 0, y0 + len);
        lg.addColorStop(0, rgba(cfg.tint, 0));
        lg.addColorStop(0.7, rgba(cfg.tint, a));
        lg.addColorStop(1, rgba(cfg.tint, a * 0.1));
        sctx.strokeStyle = lg;
        sctx.lineWidth = 1;
        sctx.beginPath();
        sctx.moveTo(x, y0);
        sctx.lineTo(x, y0 + len);
        sctx.stroke();
      }

      // 悬浮光点
      for (let i = 0; i < cfg.bokeh; i += 1) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        const r = 0.6 + Math.random() * 1.6;
        sctx.beginPath();
        sctx.fillStyle = "rgba(235,255,244," + (0.28 + Math.random() * 0.45) + ")";
        sctx.arc(x, y, r, 0, Math.PI * 2);
        sctx.fill();
      }

      // 暗角
      const v = sctx.createRadialGradient(W * 0.5, H * 0.42, H * 0.3, W * 0.5, H * 0.42, H * 0.98);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,0," + cfg.vignette + ")");
      sctx.fillStyle = v;
      sctx.fillRect(0, 0, W, H);
    }

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      for (const cv of [skyCv, rainCv]) {
        cv.width = Math.floor(W * dpr);
        cv.height = Math.floor(H * dpr);
        cv.style.width = W + "px";
        cv.style.height = H + "px";
      }
      paintSky();
      if (rctx) {
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rctx.clearRect(0, 0, W, H);
      }
      const n = Math.ceil(W / cfg.colStep);
      cols = [];
      for (let i = 0; i < n; i += 1) {
        cols.push({
          py: -Math.random() * H,
          acc: 0,
          speed: cfg.speed[0] + Math.random() * (cfg.speed[1] - cfg.speed[0]),
          hold: 0,
        });
      }
    }

    const stepY = cfg.fontSize * 1.3;

    function frame(now: number) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      // 30fps 节流，省电
      if (now - last < 33) return;
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      if (!rctx) return;

      rctx.globalCompositeOperation = "destination-out";
      rctx.fillStyle = "rgba(0,0,0," + cfg.fade + ")";
      rctx.fillRect(0, 0, W, H);
      rctx.globalCompositeOperation = "source-over";

      rctx.font = cfg.fontSize + 'px "JetBrains Mono","Cascadia Code",Consolas,monospace';
      rctx.textAlign = "center";
      rctx.textBaseline = "middle";

      for (let i = 0; i < cols.length; i += 1) {
        const c = cols[i];
        c.acc += c.speed * dt;
        while (c.acc >= stepY) {
          c.acc -= stepY;
          c.py += stepY;
          if (c.py > H + stepY) {
            c.py = -Math.random() * H * 0.8 - stepY;
            c.speed = cfg.speed[0] + Math.random() * (cfg.speed[1] - cfg.speed[0]);
          }
          const x = i * cfg.colStep + cfg.colStep / 2;
          const ch = KANA[(Math.random() * KANA.length) | 0];
          if (Math.random() < 0.14) {
            rctx.shadowColor = rgba(cfg.tint, 0.85);
            rctx.shadowBlur = cfg.glow;
            rctx.fillStyle = cfg.head;
            rctx.fillText(ch, x, c.py);
            rctx.shadowBlur = 0;
          } else {
            rctx.fillStyle = rgba(cfg.tint, 0.92);
            rctx.fillText(ch, x, c.py);
          }
        }
      }
    }

    resize();
    raf = requestAnimationFrame(frame);

    const onResize = () => resize();
    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
      delete root.dataset.rain;
      skyCv.remove();
      rainCv.remove();
    };
  }, [allowed, level]);

  if (!allowed) return null;
  return <div className="rain-host" ref={hostRef} aria-hidden="true" />;
}
