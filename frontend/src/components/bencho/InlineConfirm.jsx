/**
 * InlineConfirm — 就地确认（删除 → 已删除 · 撤销）
 *
 * 来源：Bencho "Inline confirm" block（MIT — bencho.dev/licence），
 * 由 TSX 转为 JSX 接入 Starlight 体系。英文块注释为原作设计理由，按 Bencho
 * 集成要求原样保留；中文注释是本项目的适配说明。
 *
 * 适配点（与原版的行为差异）：
 *  1. 延迟提交：onCommit 在保险丝（grace）烧尽、且用户未撤销时才触发。
 *     原版是演示用假的删除；我们接的是不可恢复的真实后端删除，
 *     只有延迟提交才能让「撤销」成为真的撤销。
 *  2. 尺寸参数化：原版是 44px 演示药丸；行内使用传 height={32}。
 *     CSS 里原版的 top:26px 演示偏移改为 top:0 + 100% 高度。
 *  3. 文案/宽度参数化 + 右锚定展开：宽度按文案字符数估算（CJK≈13px）；
 *     药井宽度恒等于静止态宽度，药丸右缘固定、弹宽时向左溢出覆盖
 *     邻居按钮（CSS :has() 同步淡出），列表行零位移、零预留空地。
 *  4. danger 模式：idle 态文字/图标用 --error，保留「危险操作」的信号色。
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Trash2, Undo2 } from "lucide-react";
import "./bencho.css";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hold = (e) => e.stopPropagation();

/* ══ 4 · confirm in place ═════════════════════════════════
   The button becomes its own dialog. Nothing opens over the
   page, nothing shifts around it, and the choice stays under
   the cursor that asked for it — a modal moves your attention
   somewhere else to answer a question you just asked here.

   Undo lives in the same footprint too, on a timer, so the
   destructive path never needs a toast either. */

/* ── one pill, two widths ─────────────────────────────────
   "Delete" at rest; pressed, it deletes at once and the same
   pill springs wide to say so and offer Undo. No confirmation
   step: an undo that is right there is kinder than a question,
   because it asks only of the people who changed their mind. */

/* 宽度估算：CJK 字符在 13px Inter 下约 13px 宽，ASCII 约 7px。
   药丸文案都很短（删除/已删除/撤销），估算足够准，免去测量 ref。 */
const textW = (s) => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 13 : 7;
  return w;
};

export default function InlineConfirm({
  label = "删除",
  doneLabel = "已删除",
  undoLabel = "撤销",
  grace = 4000,          // 撤销窗口（ms），烧尽才真正 onCommit
  height = 32,           // 行内 32；演示级 44
  danger = false,        // idle 态用 --error 信号色
  disabled = false,
  onCommit,              // 保险丝烧尽后调用（真实删除在这里）
  onUndo,                // 撤销时调用（可选，用于日志）
}) {
  const [phase, setPhase] = useState("idle");
  const timer = useRef(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const commit = () => {
    /* the one destructive action on the bench, and the only
       place `land` is used: something has happened and it is
       over. A bright note here would be celebrating a
       delete. */
    setPhase("done");
    timer.current = window.setTimeout(() => {
      setPhase("idle");
      onCommit?.();      // 适配点 1：烧尽才提交，未烧尽前一切都可撤销
    }, grace);
  };
  const undo = () => {
    window.clearTimeout(timer.current);
    setPhase("idle");
    onUndo?.();
  };

  /* out with a little give, back in firmly */
  const done = phase === "done";
  const iconIdle = height >= 40 ? 15 : 13;
  const iconDone = height >= 40 ? 14 : 12;
  const idleW = Math.ceil(iconIdle + 8 + textW(label) + 16 * 2);
  const doneW = Math.ceil(iconDone + 7 + textW(doneLabel) + 14 * 2
    + (height - 8) + textW(undoLabel) + 13 * 2 + 4);
  const w = done ? doneW : idleW;
  /* 适配点 3 修正（列表行场景）：药井宽度恒等于静止态，不预留展开宽度——
     药丸右锚定（right:0），弹宽时向左溢出盖住左侧的邻居按钮（它们由
     CSS :has() 同步淡出）。右缘不动 = 点击「删除」的光标正好落在展开后
     「撤销」按钮上，正是原作"the choice stays under the cursor"的行内版。 */
  const spring = done
    ? { type: "spring", stiffness: 420, damping: 20, mass: 0.9 }
    : { type: "spring", stiffness: 460, damping: 30, mass: 0.9 };
  const r = clamp(height / 2, 0, 22);   /* 22 is half of the 44px shell — the pill it already is */

  return (
    <div
      className={`say-well${danger ? " say-well--danger" : ""}`}
      data-phase={phase}
      style={{ "--say-r": `${r}px`, "--say-h": `${height}px`, width: idleW, height }}
    >
      <motion.span className="say-body" initial={false} animate={{ width: w }} transition={spring} />

      <AnimatePresence initial={false}>
        {!done && (
          <motion.button
            key="idle"
            type="button"
            className="say-face"
            style={{ right: 0, width: w }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.18, delay: 0.08 } }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            onClick={commit}
            onPointerDown={hold}
            disabled={disabled}
          >
            <Trash2 size={iconIdle} strokeWidth={2} />
            {label}
          </motion.button>
        )}

        {done && (
          <motion.div
            key="done"
            className="say-merged"
            style={{ right: 0, width: w }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.2, delay: 0.1 } }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
          >
            <span className="say-done">
              <Check size={iconDone} strokeWidth={2} />
              {doneLabel}
            </span>
            <button type="button" className="say-undo" onClick={undo} onPointerDown={hold}>
              <Undo2 size={iconDone - 1} strokeWidth={2} />
              {undoLabel}
            </button>
            <i className="say-fuse" style={{ animationDuration: `${grace}ms` }} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
