/* eslint-disable react/refs, react/immutability, react-hooks/exhaustive-deps --
   bencho SlideConfirm 的拖拽模式：window 级指针监听经 ref 中转（live.current）、
   motion value 每帧驱动是有意设计；完整设计理由见组件内注释。 */

import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";
import "./bencho.css";

/* ══ SlideConfirm ═════════════════════════════════════════
   架构照搬 bencho.dev "Slide to confirm"（MIT），TSX→JSX，
   文案中文化，接入 BirthTime 的危险操作确认。

   ── 手柄即答案 ──
   拖到底提交时不是切换到别处的对勾：手柄向左展开铺满它
   刚划过的轨道，箭头变成对勾——一个对象改变形状，不需要
   第二个元素来说"完成"。右缘在变形过程中纹丝不动：宽度
   增量恰好等于偏移减量，这是算术保证而不是两个动画对齐。

   ── 一切读自 x ──
   已划过区域的着色、标签褪色、箭头淡出是同一个数字的三次
   读取，而不是三个各自动画到同一时刻的东西。

   ── 完成契约（BirthTime 适配）──
   onConfirm 可返回 Promise：done 态停留（HOLD）与请求并行，
   两者都完成才调 onDone（父级此时才关界面）；请求抛错则
   回到未滑态并调 onError。完成态动效须播完再跳转——碳碳定
   的体验规则，与验证码确认动画同类。 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SPAN = 280;
const H = 52;
const PAD = 4; /* 手柄与轨道四边的内距 */
const GRIP = H - PAD * 2; /* 手柄尺寸由高度决定——加宽轨道买到的是行程 */
const MIN = 220;
const MAX = 380;
const CORNER = H / 2;
const SPEED = 50;
const SWELL = 1.03; /* hover 膨胀，很小：是致意不是事件 */
const HOLD = 1000; /* 完成态停留：确认请求与动效并行，两者都完才走下一步 */

export default function SlideConfirm({
  label = "滑动确认删除",
  doneLabel = "已确认",
  corner = CORNER,
  speed = SPEED,
  width = SPAN,
  onConfirm,
  onDone,
  onError,
}) {
  const [done, setDone] = useState(false);
  const [held, setHeld] = useState(false);
  const [hot, setHot] = useState(false);
  const track = useRef(null);
  /* 拖拽现场用 ref：每帧都变的值绝不能走 state 渲染 */
  const grip = useRef(null);
  const beat = useRef(0);

  const x = useMotionValue(0);
  /* 手柄落点：提交后它是展开宽度的锚，右缘 = PAD + GRIP + anchor（无 x），
     静止靠算术不靠两个弹簧对齐——两个弹簧差一帧就漂移 */
  const anchor = useMotionValue(0);
  /* 落地的 dip：整个块一起给 3% 再回来，读作"落定"而非"停止" */
  const pulse = useMotionValue(1);
  /* 箭头自己的淡出时钟，由提交事件切换而不是由 x */
  const shown = useMotionValue(1);

  const span = clamp(Math.round(width), MIN, MAX);
  const TRAVEL = span - PAD * 2 - GRIP;

  const r = clamp(corner, 0, CORNER);
  const gripR = Math.max(0, r - PAD); /* 同心规则：内圆角 = 外圆角 - 内距 */
  /* 提交点就是轨道尽头——能在 60% 触发的滑块一碰就响，背离手势存在的意义 */
  const mark = TRAVEL;

  /* 接管速度 0..100，阻尼永远临界（zeta=1）——两端有墙，不允许过冲 */
  const stiff = 260 + (clamp(speed, 0, 100) / 100) * 640;
  const spring = {
    type: "spring",
    stiffness: stiff,
    damping: 2 * Math.sqrt(stiff * 0.9),
    mass: 0.9,
  };
  /* 回程欠阻尼（0.62）：过冲不显示为位移（位置钳在墙），显示为挤压 */
  const home = { ...spring, damping: 2 * Math.sqrt(stiff * 0.9) * 0.62 };

  useEffect(
    () => () => {
      window.clearTimeout(beat.current);
      if (loose.current) loose.current();
    },
    []
  );

  /* 拖拽监听挂 window：capture 是 best-effort，指针离开窗口时会丢——
     在哪松手都得结束拖拽。绑定在 press 当拍而不是 effect（快滑会丢第一帧 move） */
  const loose = useRef(null);
  const live = useRef({ move: () => {}, up: () => {} });

  const watch = () => {
    if (loose.current) loose.current();
    const onMove = (e) => live.current.move(e);
    const onUp = (e) => {
      live.current.up(e);
      if (loose.current) loose.current();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    loose.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      loose.current = null;
    };
  };

  const seen = useTransform(x, (v) => clamp(v, 0, TRAVEL));
  const wide = useTransform([seen, anchor], ([v, a]) => GRIP + clamp(a - v, 0, TRAVEL));

  const over = useTransform(x, (v) => Math.max(0, -v));
  const squash = useTransform(over, (o) => 1 - Math.min(0.08, o / 110));
  const wash = useTransform(seen, (v) => v + GRIP);
  const say = useTransform(seen, [0, TRAVEL * 0.55], [1, 0]);
  const arrow = useTransform([seen, shown], ([v, on]) =>
    on * clamp(1 - (v - TRAVEL * 0.55) / (TRAVEL * 0.4), 0, 1)
  );

  const sx = useTransform(squash, (q) => q * (hot && !held && !done ? SWELL : 1));
  const sy = useTransform(squash, (q) => (1 / q) * (hot && !held && !done ? SWELL : 1));

  const local = (clientX) => {
    const box = track.current?.getBoundingClientRect();
    if (!box) return 0;
    const k = box.width / span;
    return (clientX - box.left) / (k || 1);
  };

  const finish = async () => {
    setDone(true);
    /* x 回零 + anchor 钉在提交点：宽度增的正是偏移减的，右缘不动，
       手柄在原地向左展开铺满轨道。两值同坐一个弹簧，逐帧同步。 */
    anchor.set(x.get());
    animate(shown, 0, { duration: 0.12 });
    animate(x, 0, spring);
    animate(pulse, [1, 0.974, 1], {
      duration: 0.46,
      times: [0, 0.62, 1],
      ease: [0.33, 0.55, 0.2, 1],
      delay: 0.1,
    });
    /* 完成态动效须播完再跳转（碳碳定的体验规则）：
       done 态停留与确认请求并行——请求马上发，停留照常播；
       两者都完成才 onDone（父级再关界面）；请求失败回到未滑态，
       由父级经 onError 报错 */
    let failed = null;
    const req = Promise.resolve()
      .then(() => onConfirm?.())
      .catch((e) => {
        failed = e;
      });
    const dwell = new Promise((resolve) => {
      beat.current = window.setTimeout(resolve, HOLD);
    });
    await Promise.all([req, dwell]);
    if (failed) {
      setDone(false);
      animate(shown, 1, { duration: 0.2, delay: 0.12 });
      animate(anchor, 0, { type: "spring", stiffness: 380, damping: 34, mass: 0.9 });
      onError?.(failed);
      return;
    }
    onDone?.();
  };

  const down = (e) => {
    if (done) return;
    e.stopPropagation();
    /* 偏移在第一次 MOVE 时取，不在 press 时取——press 就定会让滑块瞬移 */
    grip.current = { id: e.pointerId, grab: null, moved: false };
    setHeld(true);
    try {
      track.current?.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件的指针不活，无 capture 也能拖 */
    }
    watch();
  };

  const move = (e) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    const at = local(e.clientX);
    if (g.grab === null) {
      g.grab = at - x.get();
      return;
    }
    const next = clamp(at - g.grab, 0, TRAVEL);
    if (Math.abs(next - x.get()) > 0.5) g.moved = true;
    x.set(next);
  };

  const up = (e) => {
    const g = grip.current;
    if (!g) return;
    grip.current = null;
    try {
      track.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 从未 capture */
    }
    setHeld(false);
    if (x.get() >= mark) finish();
    else animate(x, 0, home);
  };

  live.current = { move, up };

  /* 键盘可达性：手柄是真 button——Enter/Space 等效拖到底（屏幕阅读器
     与键盘用户也能完成确认） */
  const keyConfirm = (e) => {
    if (done) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      finish();
    }
  };

  return (
    <div className="sld" style={{ width: span, height: H }}>
      <motion.div
        className="sld-track"
        ref={track}
        style={{ borderRadius: r, scale: pulse }}
        data-held={held || undefined}
        data-done={done || undefined}
        onPointerDown={down}
      >
        <motion.i className="sld-wash" aria-hidden="true" style={{ width: wash, borderRadius: gripR }} />

        <motion.span className="sld-say" style={{ opacity: say }}>
          {label}
        </motion.span>

        <motion.button
          type="button"
          className="sld-grip"
          onPointerEnter={() => setHot(true)}
          onPointerLeave={() => setHot(false)}
          onKeyDown={keyConfirm}
          style={{
            x: seen,
            scaleX: sx,
            scaleY: sy,
            /* 几何尺寸全部内联（top/height/width 同源 JS 常量）：手柄是正圆
               的充要条件不被任何外部 CSS 污染——css 里再写 height 就是椭圆 */
            top: PAD,
            height: GRIP,
            /* morph 是一个数字：宽读自 x 与 anchor 的算术，不用 scale——
               scale 会连圆角一起拖变形 */
            width: wide,
            borderRadius: gripR,
          }}
          transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.7 }}
          aria-label={done ? doneLabel : label}
        >
          <motion.span className="sld-arrow" style={{ opacity: arrow }} aria-hidden="true">
            <ArrowRight size={19} strokeWidth={2.4} />
          </motion.span>

          <motion.span
            className="sld-done"
            aria-hidden="true"
            initial={false}
            animate={{ opacity: done ? 1 : 0, scale: done ? 1 : 0.7 }}
            transition={{ duration: 0.18, ease: [0.33, 0.55, 0.2, 1] }}
          >
            <Check size={18} strokeWidth={2.8} />
            {doneLabel}
          </motion.span>
        </motion.button>
      </motion.div>
    </div>
  );
}
