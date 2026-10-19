/**
 * UploadDropzone — 真实文件上传区（Bencho "Upload dropzone" 块的视觉语言，MIT）
 *
 * 原块是演示件（NO REAL FILES：托盘假文件、假上传），这里只借视觉：
 *   盒子吸气（拖入悬停放大回弹）/ 吞咽 gulp / Page 文件图标（扩展名色标）/
 *   Roll 滚动百分比 / 进度条 + 完成对勾 / 拒绝抖动 + 红字。
 * 交互本体按 Stellaris 真实流程重写：隐藏 input 点击浏览 + 系统级拖拽，
 * 状态机由父组件（HomePage）驱动（受控组件）。
 *
 * 阶段：idle（待选）→ picked（已选，预估卡在下方）→ uploading（真实 XHR
 * 进度）→ done（对勾停一拍，父组件跳详情页）；refuse 为抖动 + 红字的瞬态。
 */
import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "framer-motion";
import { Check, Upload as UpIcon } from "lucide-react";
import "./bencho.css";

/* 与后端 config.py MAX_VIDEO_SIZE_MB 对齐（2048MB） */
const MAX_MB = 2048;

const VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "flv"];
const AUDIO_EXTS = ["mp3", "m4a", "wav", "ogg", "flac", "aac"];
const ACCEPT_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

export const extOf = (name = "") =>
  name.includes(".") ? name.split(".").pop().toLowerCase() : "";

/* 扩展名 → 色标（Starlight 映射：视频=品牌紫，音频=成功绿，其他=灰） */
const extTint = (ext) =>
  VIDEO_EXTS.includes(ext) ? "var(--accent)"
    : AUDIO_EXTS.includes(ext) ? "var(--success)"
    : "var(--mute)";

/* ── the file icon ─────────────────────────────────────────
   After Untitled UI's: a rounded page on a 40 grid with a thin
   grey outline and a folded corner, and the extension on a
   coloured label that sticks out past the page's left edge —
   the colour carries the kind before the word is read.
   （BirthTime FilePage 同款，style.fill 消费 CSS 变量） */
export function FilePage({ filename, size = 40 }) {
  const ext = extOf(filename).toUpperCase() || "FILE";
  return (
    <svg className="upl-page" width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        className="upl-page-line"
        d="M7.75 4A3.25 3.25 0 0 1 11 .75h16c.121 0 .238.048.323.134l10.793 10.793a.46.46 0 0 1 .134.323v24A3.25 3.25 0 0 1 35 39.25H11A3.25 3.25 0 0 1 7.75 36z"
      />
      <path className="upl-page-line" d="M27 .5V8a4 4 0 0 0 4 4h7.5" />
      <rect width="29" height="16" x="1" y="18" rx="8" style={{ fill: extTint(extOf(filename)) }} />
      <text x="15.5" y="29.3" textAnchor="middle" fontSize="9" className="upl-page-ext">{ext}</text>
    </svg>
  );
}

/* ── Roll：滚动百分比（Bencho 原作，逐位翻滚）── */
export function Roll({ value }) {
  const s = String(Math.round(clamp(value, 0, 100)));
  return (
    <span className="upl-roll" aria-label={`${s}%`}>
      {s.split("").map((d, i) => (
        <span key={s.length - i} className="upl-roll-col">
          <span className="upl-roll-strip" style={{ transform: `translateY(${-Number(d)}em)` }}>
            {"0123456789".split("").map((n) => <span key={n}>{n}</span>)}
          </span>
        </span>
      ))}
      %
    </span>
  );
}

export default function UploadDropzone({
  phase = "idle",          // idle | picked | uploading | done | refuse
  fileInfo = null,         // { name, size }
  progress = 0,            // uploading 时 0-100
  refuseMsg = null,        // refuse 阶段的红字
  onFile,                  // 校验通过后的真实文件回调
  disabled = false,
}) {
  const [over, setOver] = useState(false);       // 系统拖拽悬停在盒子上
  const [gulp, setGulp] = useState(false);       // 吞咽动画
  const input = useRef(null);
  const shake = useAnimationControls();
  const dragDepth = useRef(0);                   // dragenter/leave 配对计数
  const timers = useRef([]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const later = (fn, ms) => { timers.current.push(window.setTimeout(fn, ms)); };

  /* refuse 瞬态：抖动 + 红字，1.8s 后回 idle（父组件只需把 phase 置 refuse） */
  useEffect(() => {
    if (phase !== "refuse") return;
    shake.start({ x: [0, -7, 6, -4, 2, 0], transition: { duration: 0.42 } });
  }, [phase, shake]);

  const acceptFile = (file) => {
    if (!file || disabled) return;
    const ext = extOf(file.name);
    if (!ACCEPT_EXTS.includes(ext)) {
      /* 不支持的格式：本地拒，不惊动父组件探时长 */
      shake.start({ x: [0, -7, 6, -4, 2, 0], transition: { duration: 0.42 } });
      onFile?.(null, `不支持 .${ext || "未知"} 格式，支持 MP4 / MKV / MOV / MP3 / WAV 等`);
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      shake.start({ x: [0, -7, 6, -4, 2, 0], transition: { duration: 0.42 } });
      onFile?.(null, `文件过大，上限 ${MAX_MB / 1024} GB`);
      return;
    }
    /* the gulp: in a little as the file goes down, out past its size,
       and settle */
    setGulp(true);
    later(() => setGulp(false), 460);
    onFile?.(file, null);
  };

  const busy = phase === "uploading" || phase === "done";
  const showFile = fileInfo && phase !== "idle" && phase !== "refuse";

  return (
    <div className="upl">
      <motion.div animate={shake} className="upl-zone-wrap">
        <div
          className="upl-zone"
          data-over={over || undefined}
          data-refuse={phase === "refuse" || undefined}
          data-gulp={gulp || undefined}
          data-busy={busy || undefined}
          role="button"
          tabIndex={0}
          aria-label="上传视频或音频文件"
          onClick={() => { if (!disabled && !busy && phase !== "picked") input.current?.click(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !disabled && !busy && phase !== "picked") input.current?.click(); }}
          onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; if (!disabled) setOver(true); }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setOver(false); } }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setOver(false);
            if (disabled || busy) return;
            acceptFile(e.dataTransfer?.files?.[0]);   /* 多文件只取第一个（对齐旧行为） */
          }}
        >
          {!showFile ? (
            <>
              <span className="upl-icon"><UpIcon size={18} strokeWidth={2} /></span>
              <span className="upl-say">
                <b>{phase === "refuse" ? refuseMsg : over ? "松手即可上传" : "点击或拖拽视频 / 音频文件到此处"}</b>
                <span>MP4 / MKV / AVI / MOV / FLV / MP3 / M4A / WAV · 按实际时长计量</span>
              </span>
            </>
          ) : (
            <span className="upl-now" key={fileInfo.name}>
              <FilePage filename={fileInfo.name} size={36} />
              <span className="upl-text">
                <span className="upl-name">{fileInfo.name}</span>
                <span className="upl-meta">
                  {fmtSize(fileInfo.size)}
                  {" · "}
                  {phase === "done" ? "已上传"
                    : phase === "uploading" ? <Roll value={progress} />
                    : "待确认"}
                </span>
                {(phase === "uploading" || phase === "done") && (
                  <span className="upl-track">
                    <span className="upl-bar" style={{ transform: `scaleX(${phase === "done" ? 1 : clamp(progress, 0, 100) / 100})` }} />
                  </span>
                )}
              </span>
              {/* the tick's room is kept from the start, so the box
                  is its final size before the tick arrives */}
              <span className="upl-end">
                {phase === "done" && <span className="upl-tick"><Check size={14} strokeWidth={2} /></span>}
              </span>
            </span>
          )}
        </div>
      </motion.div>

      <input
        ref={input}
        type="file"
        accept={ACCEPT_EXTS.map((e) => `.${e}`).join(",")}
        style={{ display: "none" }}
        onChange={(e) => {
          acceptFile(e.target.files?.[0]);
          e.target.value = "";   /* 允许重选同一个文件 */
        }}
      />
    </div>
  );
}
