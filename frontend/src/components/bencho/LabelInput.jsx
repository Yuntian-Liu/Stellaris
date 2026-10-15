import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, X } from "lucide-react";
import "./bencho.css";

/* ══ Label input ══════════════════════════════════════════
   A field whose label is its placeholder until you are in it.
   On focus the label lifts into the top edge with a small hop
   running along its letters, the outline darkens in place, and
   the top line parts under the label from its middle outward.

   ── ONE THING MOVES ─────────────────────────────────────
   It used to DRAW its outline out of the notch, both ways
   round the field — and that was the field performing, which
   is too much for a thing you focus forty times a day. Now the
   outline is always whole; focus only changes its ink and
   opens the gap. The label is the event, and the line makes
   room for it.

   The gap is two short paths across the notch, each from the
   middle to one side, retracted from the middle outward by a
   negative dash offset.

   ── ADAPTED FOR BIRTHTIME ───────────────────────────────
   The bench fixed W=280 and held its own value. Here the ring
   is drawn from the measured box width (100% forms welcome),
   the label is a free prop (中文 included — the notch is still
   the label's measured width), and the value is controlled by
   the form that owns it.

   ── ADAPTED FOR STELLARIS ────────────────────────────────
   三个新 prop：onEnter（回车触发，首页链接框回车=解析）、
   disabled（提交中禁用）、clearable（非 secret 时右缘 × 清除钮，
   复用 lbi-eye 的绝对定位模式，点击后焦点留在框内）。 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const H = 52;
/* the lifted label's size, against its resting one */
const S = 0.78;
/* the stroke sits half a stroke inside the box so none of it
   is clipped by the svg's own edge */
const IN = 0.75;

export default function LabelInput({
  label = "邮箱",
  value,
  onChange,
  type = "text",
  /* the field's corner, px — at half the height it is a pill */
  corner = 14,
  secret = false,
  autoComplete = "off",
  autoFocus = false,
  name,
  /* 父级需要聚焦态时回传（如首页查询框的分化按钮） */
  onFocusChange,
  /* Stellaris 适配：回车 / 禁用 / 清除钮 / 长度上限 */
  onEnter,
  disabled = false,
  clearable = false,
  maxLength,
  /* a showcase, not a form: on a touch screen, keep the device's
     keyboard down. Off by default — a real field wants its
     keyboard — and the bench turns it on for its feed */
  showcase = false,
}) {
  const r = clamp(corner, 0, H / 2);
  const id = `lbi-${useId().replace(/:/g, "")}`;

  const box = useRef(null);
  const [w, setW] = useState(280);
  const [focus, setFocus] = useState(false);
  const [quiet] = useState(() => showcase && typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
  const [show, setShow] = useState(false);
  const [flip, setFlip] = useState(0);
  const input = useRef(null);

  /* the ring is drawn from the measured width, not a constant */
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      setW(Math.max(120, Math.round(entries[0].contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* the notch is the label's own width, so it is measured */
  const lab = useRef(null);
  const [lw, setLw] = useState(40);
  useLayoutEffect(() => {
    if (lab.current) setLw(lab.current.offsetWidth);
  }, [label, w]);

  /* a secret field hides on reveal toggles; the flip restarts
     the blur pass (two names, alternating) */
  const up = focus || (value || "").length > 0;

  /* ── where the label sits, and the gap it leaves ─────────
     Never inside the corner's curve: the notch has to open on
     the straight part of the top edge, so a rounder field
     starts its label further in. */
  const lx = Math.max(14, r + 4);
  const x0 = Math.max(r * 0.6, lx - 5);
  const x1 = lx + lw * S + 5;
  const a = r - IN;
  const R = w - IN;
  const B = H - IN;
  const mid = w / 2;
  /* the gap, as two halves from its middle to each side */
  const nm = (x0 + x1) / 2;
  const gapL = `M${nm},${IN} L${x0},${IN}`;
  const gapR = `M${nm},${IN} L${x1},${IN}`;
  /* right: from the notch, clockwise, to the bottom middle */
  const right = r > 0
    ? `M${x1},${IN} L${w - r},${IN} A${a},${a} 0 0 1 ${R},${r} L${R},${H - r} A${a},${a} 0 0 1 ${w - r},${B} L${mid},${B}`
    : `M${x1},${IN} L${R},${IN} L${R},${B} L${mid},${B}`;
  /* left: from the notch, the other way round, to the same point */
  const left = r > 0
    ? `M${x0},${IN} L${r},${IN} A${a},${a} 0 0 0 ${IN},${r} L${IN},${H - r} A${a},${a} 0 0 0 ${r},${B} L${mid},${B}`
    : `M${x0},${IN} L${IN},${IN} L${IN},${B} L${mid},${B}`;

  const reveal = () => {
    setShow((s) => !s);
    setFlip((f) => f + 1);
  };

  return (
    <div className="lbi" data-up={up} data-focus={focus} data-filled={(value || "").length > 0} data-disabled={disabled || undefined}>
      <div
        className="lbi-box"
        ref={box}
        style={{ height: H, borderRadius: r, "--lbi-x": `${lx}px` }}
      >
        <svg className="lbi-ring" width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
          <path d={right} />
          <path d={left} />
          <path className="lbi-gap" d={gapL} pathLength={1} />
          <path className="lbi-gap" d={gapR} pathLength={1} />
        </svg>

        <label className="lbi-label" htmlFor={id} ref={lab}>
          {[...label].map((ch, i) => (
            <span key={i} style={{ "--i": i }}>{ch}</span>
          ))}
        </label>

        <input
          ref={input}
          id={id}
          name={name}
          className="lbi-field"
          data-flip={flip % 2}
          type={secret && !show ? "password" : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onEnter?.(); }}
          onFocus={() => { setFocus(true); onFocusChange?.(true); }}
          onBlur={() => { setFocus(false); onFocusChange?.(false); }}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          maxLength={maxLength}
          spellCheck={false}
          /* ── no keyboard, when it is only being shown ─────
             In a feed you are scrolling on a phone, a tap that
             lands on the field threw the keyboard up over the
             page. inputMode "none" keeps everything the block is
             about — the focus, the label lifting, the gap
             opening — and only tells the device not to raise its
             keyboard. A mouse and a hardware keyboard are
             untouched, and so is any real use of this field. */
          inputMode={quiet ? "none" : undefined}
          style={{ paddingRight: secret || clearable ? 48 : lx }}
        />

        {clearable && !secret && (value || "").length > 0 && !disabled && (
          <button
            className="lbi-eye lbi-clear"
            type="button"
            /* 与眼睛同款：onPointerDown 拦截，点击清除后焦点留在框内 */
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onChange("")}
            aria-label="清空"
          >
            <X size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        )}

        {secret && (
          <button
            className="lbi-eye"
            type="button"
            data-show={show}
            /* keep focus in the field: the eye is a toggle on
               what you are typing, not somewhere to go */
            onPointerDown={(e) => e.preventDefault()}
            onClick={reveal}
            aria-label={show ? "Hide password" : "Show password"}
          >
            <Eye size={16} strokeWidth={2} aria-hidden="true" />
            <EyeOff size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
