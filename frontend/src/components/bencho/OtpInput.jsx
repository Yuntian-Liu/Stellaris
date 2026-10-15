/* eslint-disable react/refs, react/purity, react-hooks/exhaustive-deps --
   bencho Otp 的 rAF 动画模式：渲染期读 ref + performance.now() 是有意设计
   （rAF 循环写 ref，setTick 强制重绘；静止时循环自停零开销）。 */

import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import "./bencho.css";

/* ══ OtpInput ══════════════════════════════════════════════════
   架构照搬 bencho.dev 的 "One-time code" 组件（MIT licence），
   按本项目 tokens 与流程重写：

   ── 六格一体 ──
   只有隐形 input 盖在整行上，格子画在它底下——粘贴、短信
   自动填充（autocomplete=one-time-code）、退格、读屏全是
   浏览器原生行为，六个真实 input 会把这些全部破坏。

   ── 答对融合 / 答错抖动 ──
   格子在一层 blur+threshold 滤镜（goo）下，间距足够近才融合。
   onComplete 通过后格子滑向中间、胶囊从同一点长出，滤镜把
   它们接成一个形状；失败则一行衰减波抖动，数字从右往左排空。

   ── 帧率无关的弹簧 ──
   dt 以 1/60s 帧为单位，阻尼用幂而非乘法：掉帧不改变能量衰减。
   循环在所有运动停下后自行 park，静止的输入框零开销。 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => {
  const u = clamp((v - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

/* 格子与间距（px），胶囊宽随 length 派生 */
const W = 40;
const H = 52;
const G = 8;
const POP_MS = 260;
const SHAKE_MS = 620;
/* 融合弹簧：略欠阻尼，让胶囊冲过头再回弹，读作"液体"而非"滑动" */
const MERGE = (() => {
  const k = 0.075;
  const zeta = 0.42;
  return { k, d: 1 - 2 * zeta * Math.sqrt(k) };
})();

const stillness = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useGoo(blur = 3, cut = 24) {
  /* useId 的冒号在 url(#) 里不合法，剥掉 */
  const id = `goo-${useId().replace(/:/g, "")}`;
  const goo = (
    <svg className="liq-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id={id} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="smear" />
          <feColorMatrix
            in="smear"
            type="matrix"
            values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${cut} ${-(cut / 2)}`}
          />
        </filter>
      </defs>
    </svg>
  );
  return { url: `url(#${id})`, goo };
}

/* onComplete：输满时调用（返回 Promise<boolean>，true=通过走融合，false=抖动排空）；
   只传 onChange 则为纯收集模式（忘记密码弹窗用）。 */
export default function OtpInput({ length = 6, onChange, onComplete }) {
  const n = length;
  const rowW = n * W + (n - 1) * G;
  const still = stillness();

  const [code, setCode] = useState("");
  const [phase, setPhase] = useState("type");
  const [focus, setFocus] = useState(false);
  const input = useRef(null);

  const caret = useRef({ x: W / 2, v: 0 });
  const popAt = useRef([]);
  const merge = useRef({ m: 0, v: 0, to: 0 });
  const shook = useRef(0);
  const timers = useRef([]);
  const raf = useRef(0);
  const [, setTick] = useState(0);
  const live = useRef({ code, n });
  live.current = { code, n };

  const later = (fn, ms) => timers.current.push(window.setTimeout(fn, ms));

  const wake = () => {
    if (raf.current) return;
    let prev = 0;
    const tick = (t) => {
      const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      let busy = false;
      const { code: c, n: count } = live.current;

      /* 光标：带一点惯性的弹簧 */
      const target = Math.min(c.length, count - 1) * (W + G) + W / 2;
      const k = caret.current;
      if (still) {
        k.x = target;
        k.v = 0;
      } else {
        k.v += (target - k.x) * 0.2 * dt;
        k.v *= Math.pow(0.62, dt);
        k.x += k.v * dt;
        if (Math.abs(target - k.x) < 0.05 && Math.abs(k.v) < 0.05) {
          k.x = target;
          k.v = 0;
        } else busy = true;
      }

      /* 融合：弹簧驱动 */
      const mg = merge.current;
      if (mg.m !== mg.to || mg.v !== 0) {
        if (still) {
          mg.m = mg.to;
          mg.v = 0;
        } else {
          mg.v += (mg.to - mg.m) * MERGE.k * dt;
          mg.v *= Math.pow(MERGE.d, dt);
          mg.m += mg.v * dt;
          if (Math.abs(mg.to - mg.m) < 0.0008 && Math.abs(mg.v) < 0.0008) {
            mg.m = mg.to;
            mg.v = 0;
          } else busy = true;
        }
      }

      if (t - shook.current < SHAKE_MS + 200) busy = true;

      setTick((x) => x + 1);
      if (popAt.current.some((at) => t - at < POP_MS)) busy = true;
      raf.current = busy ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      timers.current.forEach(window.clearTimeout);
    },
    []
  );
  useEffect(() => {
    wake();
  }, [code, n, phase]);

  const fuse = (to) => {
    merge.current = { ...merge.current, to };
    wake();
  };

  const handleChange = (raw) => {
    if (phase !== "type") return;
    const next = raw.replace(/\D/g, "").slice(0, n);
    /* 新数字落格时格子轻微膨胀——粘贴则沿行依次弹起 */
    if (!still && next.length > code.length) {
      const t0 = performance.now();
      for (let i = code.length; i < next.length; i++) popAt.current[i] = t0 + (i - code.length) * 45;
      wake();
    }
    setCode(next);
    onChange?.(next);
    if (next.length < n) return;
    /* 输满：无 onComplete 只停在这里（收集模式）；有则先呼吸一拍再验证 */
    if (!onComplete) return;
    setPhase("check");
    later(async () => {
      let ok = false;
      try {
        ok = (await onComplete(next)) === true;
      } catch {
        ok = false;
      }
      if (ok) {
        setPhase("ok");
        fuse(1);
        input.current?.blur();
      } else {
        setPhase("no");
        shook.current = performance.now();
        wake();
        later(() => {
          setCode("");
          setPhase("type");
        }, SHAKE_MS + n * 45 + 160);
      }
    }, still ? 0 : 420);
  };

  /* 胶囊按一下就拆回空格（认证成功即将切步，一般用不到） */
  const reopen = () => {
    if (phase !== "ok") return;
    setCode("");
    setPhase("type");
    fuse(0);
    input.current?.focus();
  };

  const now = performance.now();
  const raw = merge.current.m;
  const m = clamp(raw, 0, 1);
  const mid = (rowW - W) / 2;
  const since = now - shook.current;
  const shaking = phase === "no" && since < SHAKE_MS && !still;
  const shake = (i) =>
    shaking ? 5 * Math.exp(-since / 190) * Math.sin((since / 1000) * Math.PI * 2 * 10 + i * 0.55) : 0;
  const cellX = (i) => mix(i * (W + G), mid, m) + shake(i);
  const pop = (i) => {
    const at = popAt.current[i];
    if (at === undefined) return 1;
    const u = (now - at) / POP_MS;
    return u > 0 && u < 1 ? 1 + 0.04 * Math.sin(Math.PI * u) : 1;
  };
  const breath = (i) => {
    if (phase !== "check" || still) return pop(i);
    const u = ((now % 900) / 900) * (n + 2) - i;
    return 1 - 0.07 * (u > 0 && u < 2 ? Math.sin((u / 2) * Math.PI) : 0);
  };
  const over = raw - 1;
  const capW = 148 * smooth(0.3, 1, m) * (1 + Math.max(-0.12, over) * 0.9);
  const capSy = 1 - Math.max(-0.12, over) * 0.55;
  const cellR = mix(12, H / 2, smooth(0.15, 0.7, m));
  const typing = phase === "type" && focus;

  const { url, goo } = useGoo();

  return (
    <div className="otp" data-phase={phase}>
      <div className="otp-row" style={{ width: rowW, height: H }}>
        <div className="otp-goo" aria-hidden="true" style={{ filter: still ? undefined : url }}>
          {Array.from({ length: n }, (_, i) => (
            <span
              key={i}
              className="otp-cell"
              style={{
                width: W,
                borderRadius: cellR,
                transform: `translateX(${cellX(i).toFixed(2)}px) scale(${breath(i).toFixed(3)})`,
              }}
            />
          ))}
          {capW > 0.5 && (
            <span
              className="otp-capsule"
              style={{
                width: capW,
                borderRadius: H / 2,
                transform: `translateX(${((rowW - capW) / 2).toFixed(2)}px) scaleY(${capSy.toFixed(3)})`,
              }}
            />
          )}
        </div>

        {Array.from({ length: n }, (_, i) => {
          const d = code[i];
          const x = cellX(i);
          const out = phase === "no" && !still ? smooth(0, 1, (since - 300 - (n - 1 - i) * 45) / 220) : 0;
          return (
            <span
              key={i}
              className="otp-slot"
              style={{
                width: W,
                transform: `translateX(${x.toFixed(2)}px)`,
                opacity: 1 - smooth(0, 0.45, m),
              }}
            >
              {d && (
                <span
                  key={`${i}-${d}`}
                  className="otp-digit"
                  style={{ translate: `0 ${(out * 8).toFixed(2)}px`, opacity: 1 - out }}
                >
                  {d}
                </span>
              )}
            </span>
          );
        })}

        <i
          className="otp-caret"
          data-on={typing && code.length < n && m < 0.08 ? "true" : undefined}
          style={{
            transform: `translateX(${(caret.current.x - 1).toFixed(2)}px) scaleX(${(1 + Math.min(5, Math.abs(caret.current.v) * 0.9)).toFixed(3)})`,
          }}
        />

        <span
          className="otp-ok"
          style={{ opacity: smooth(0.72, 1, m), scale: `${mix(0.92, 1, smooth(0.72, 1, m))}` }}
        >
          <Check size={14} strokeWidth={2.4} aria-hidden="true" />
          已验证
        </span>

        <input
          ref={input}
          className="otp-field"
          value={code}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onPointerDown={(e) => {
            if (phase === "ok") {
              e.preventDefault();
              reopen();
            }
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={n}
          aria-label={phase === "ok" ? "已验证" : `${n} 位验证码`}
          spellCheck={false}
        />
      </div>
      {goo}
    </div>
  );
}
