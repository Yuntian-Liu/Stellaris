"""
管线第 3 步：小米 Mimo ASR 语音识别

使用 OpenAI 兼容 SDK 调用 Mimo API（model: mimo-v2.5-asr）
音频以 base64 编码通过 chat completions 接口发送。
"""
import os
import base64
import json
import logging
import subprocess
from pathlib import Path

from openai import OpenAI

from config import MIMO_API_KEY, MIMO_BASE_URL, MIMO_MODEL, FFMPEG_PATH, FFPROBE_PATH

logger = logging.getLogger(__name__)

# ── 客户端实例（复用连接）───────────────────────────────
_client: OpenAI | None = None


def _get_client() -> OpenAI:
    """懒初始化 Mimo 客户端，支持热更新 key。"""
    global _client
    key = os.environ.get("MIMO_API_KEY") or MIMO_API_KEY
    if not key:
        raise RuntimeError(
            "MIMO_API_KEY 未设置。请设置环境变量或在 config.py 中配置。"
        )
    # 每次 key 变化时重建客户端
    if _client is None or _client.api_key != key:
        _client = OpenAI(api_key=key, base_url=MIMO_BASE_URL)
    return _client


def transcribe_with_mimo(audio_path: Path, task_id: str) -> dict:
    """
    调用小米 Mimo ASR 将音频转为文字。

    支持长音频：自动检测是否超出 Mimo token 限制（8192），
    超出时自动切分为 ~50s 小段，逐段识别后拼接。

    Args:
        audio_path: 音频文件路径 (wav/mp3/m4a 等)
        task_id: 任务 ID（用于日志追踪）

    Returns:
        {
            "segments": [{"start": float, "end": float, "text": str}, ...],
            "full_text": str,
            "source": "asr_mimo"
        }
    """
    client = _get_client()
    logger.info("[Mimo ASR] 开始识别: %s (%.1fMB) (task=%s)",
                audio_path.name, audio_path.stat().st_size / (1024 * 1024), task_id)

    # ── 预处理：压缩 + 分段 ───────────────────────────────
    MIMO_MAX_AUDIO_MB = 10
    CHUNK_DURATION_SEC = 25   # 每段约 25 秒，确保不超 8192 token 限制

    actual_audio = audio_path
    file_size_mb = audio_path.stat().st_size / (1024 * 1024)

    # 步骤 A: 压缩（如果 > 10MB）
    if file_size_mb > MIMO_MAX_AUDIO_MB:
        logger.info("[Mimo ASR] 音频 %.1fMB > %dMB，压缩中...", file_size_mb, MIMO_MAX_AUDIO_MB)
        actual_audio = _compress_for_asr(audio_path, task_id)
        logger.info("[Mimo ASR] 压缩后: %.1fMB", actual_audio.stat().st_size / (1024 * 1024))

    # 步骤 B: 检查是否需要分段
    chunks = _split_audio_if_needed(actual_audio, task_id, chunk_sec=CHUNK_DURATION_SEC)

    # ── 逐段调用 Mimo ASR ─────────────────────────────────
    all_segments = []
    offset_sec = 0.0

    for idx, chunk_path in enumerate(chunks):
        chunk_mb = chunk_path.stat().st_size / (1024 * 1024)
        logger.info("[Mimo ASR] 处理段 %d/%d (%.1fMB, 偏移 %.0fs)...",
                    idx + 1, len(chunks), chunk_mb, offset_sec)

        with open(chunk_path, "rb") as f:
            audio_bytes = f.read()
        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

        mime_type = _guess_mime(chunk_path)

        try:
            completion = client.chat.completions.create(
                model=MIMO_MODEL,
                messages=[{
                    "role": "user",
                    "content": [{
                        "type": "input_audio",
                        "input_audio": {
                            "data": f"data:{mime_type};base64,{audio_base64}"
                        }
                    }]
                }],
                extra_body={"asr_options": {"language": "auto"}},
            )
        except Exception as e:
            logger.error("[Mimo ASR] 段 %d 识别失败 (task=%s): %s", idx + 1, task_id, e)
            raise

        # 解析这段结果
        result = _parse_mimo_response(completion, f"{task_id}_chunk{idx}")
        if result["segments"]:
            # 给每段加上时间偏移
            for seg in result["segments"]:
                if seg["start"] == 0.0 and seg["end"] == 0.0:
                    # 纯文本 fallback: 按段落长度估算时间
                    seg["start"] = offset_sec
                    seg["end"] = offset_sec + CHUNK_DURATION_SEC
                else:
                    seg["start"] += offset_sec
                    seg["end"] += offset_sec
            all_segments.extend(result["segments"])

        # 推进偏移量（用 FFprobe 获取这段实际时长更准，但简化起见用固定值）
        offset_sec += CHUNK_DURATION_SEC

        # 清理临时分片文件
        if chunk_path != actual_audio:
            chunk_path.unlink(missing_ok=True)

    # ── 拼接全文 ───────────────────────────────────────
    full_text = " ".join(seg["text"] for seg in all_segments)

    logger.info("[Mimo ASR] 识别完成: %d 段, %d 字符, %d tokens估算 (task=%s)",
                len(chunks), len(full_text), int(len(full_text) / 3), task_id)

    return {
        "segments": all_segments,
        "full_text": full_text,
        "source": "asr_mimo",
    }


def _parse_mimo_response(completion, task_id: str) -> dict:
    """
    解析 Mimo 返回的 chat completion 为统一 segments 格式。

    Mimo 的返回结构（基于 OpenAI chat completions 格式）：
      choices[0].message.content → 可能是纯文本或带时间戳的结构化 JSON
      也可能在 choices[0].message.content 中包含 JSON 块

    统一输出格式：
      segments: [{start, end, text}, ...]
      full_text: 拼接全文
      source: "asr_mimo"
    """
    content = completion.choices[0].message.content if completion.choices else ""
    usage = completion.usage

    segments = []
    full_text = ""

    # 尝试解析：Mimo 可能返回纯文本或结构化数据
    if not content:
        logger.warning("[Mimo ASR] 返回内容为空 (task=%s)", task_id)
        return {"segments": [], "full_text": "", "source": "asr_mimo"}

    # 策略 A：尝试从 content 中提取 JSON（Mimo 可能嵌套结果）
    json_blocks = _extract_json_from_content(content)

    if json_blocks:
        # 找到结构化数据，按 Mimo 实际格式解析
        for block in json_blocks:
            if isinstance(block, list):
                for item in block:
                    seg = _normalize_segment(item)
                    if seg:
                        segments.append(seg)
            elif isinstance(block, dict):
                # 可能是 {"segments": [...]} 或 {"text": "..."} 等格式
                segs = block.get("segments") or block.get("results")
                if segs and isinstance(segs, list):
                    for item in segs:
                        seg = _normalize_segment(item)
                        if seg:
                            segments.append(seg)
                text = block.get("text") or block.get("transcript")
                if text and isinstance(text, str):
                    full_text = text

    # 策略 B：纯文本 fallback — 整段作为单个 segment
    if not segments:
        full_text = content.strip()
        segments.append({
            "start": 0.0,
            "end": 0.0,
            "text": full_text,
        })

    # 如果 full_text 还没被填充，从 segments 拼接
    if not full_text:
        full_text = " ".join(seg["text"] for seg in segments)

    return {
        "segments": segments,
        "full_text": full_text,
        "source": "asr_mimo",
        "_raw_usage": {
            "prompt_tokens": getattr(usage, 'prompt_tokens', None) if usage else None,
            "completion_tokens": getattr(usage, 'completion_tokens', None) if usage else None,
            "total_tokens": getattr(usage, 'total_tokens', None) if usage else None,
        } if usage else None,
    }


def _extract_json_from_content(content: str) -> list:
    """从文本中提取所有 JSON 对象/数组（处理 markdown 代码块包裹的情况）。"""
    results = []

    # 尝试直接解析整个 content
    try:
        parsed = json.loads(content)
        results.append(parsed)
        return results
    except (json.JSONDecodeError, ValueError):
        pass

    # 尝试提取 ```json ... ``` 代码块
    import re
    json_pattern = re.compile(r'```(?:json)?\s*\n?(.*?)\n?```', re.DOTALL)
    matches = json_pattern.findall(content)
    for match in matches:
        try:
            results.append(json.loads(match.strip()))
        except (json.JSONDecodeError, ValueError):
            continue

    # 尝试找 [...] 或 {...} 结构
    bracket_pattern = re.compile(r'(\{[\s\S]*\}|\[[\s\S]*\])')
    matches = bracket_pattern.findall(content)
    for match in matches:
        try:
            parsed = json.loads(match)
            if parsed not in results:
                results.append(parsed)
        except (json.JSONDecodeError, ValueError):
            continue

    return results


def _normalize_segment(item) -> dict | None:
    """将各种可能的 segment 格式标准化为 {start, end, text}。"""
    if not isinstance(item, dict):
        return None

    text = item.get("text") or item.get("content") or item.get("transcript") or ""
    if not isinstance(text, str) or not text.strip():
        return None

    start = _to_float(item.get("start") or item.get("begin") or item.get("from") or 0.0)
    end = _to_float(item.get("end") or item.get("finish") or item.get("to") or 0.0)

    return {
        "start": start,
        "end": end,
        "text": text.strip(),
    }


def _to_float(value) -> float:
    """安全转 float。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _guess_mime(audio_path: Path) -> str:
    """根据扩展名推断 MIME 类型。"""
    mime_map = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
    }
    return mime_map.get(audio_path.suffix.lower(), "audio/wav")


def _split_audio_if_needed(audio_path: Path, task_id: str, chunk_sec: int = 50) -> list[Path]:
    """
    如果音频可能超出 Mimo token 限制，用 FFmpeg 切分为小段。

    简单策略：按固定时长切分，最后一段可能较短。
    返回分片文件路径列表（调用方负责清理）。
    """
    # 用 ffprobe 获取音频时长
    try:
        probe = subprocess.run(
            [FFPROBE_PATH, "-i", str(audio_path), "-show_entries", "format=duration", "-v", "quiet"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=10,
        )
        logger.info("[Mimo ASR] ffprobe returncode=%d, stdout=%s",
                    probe.returncode, probe.stdout[:100])
        # ffprobe 输出: [FORMAT]\nduration=xxx\n[/FORMAT]，需要提取 duration= 那一行
        duration = 0.0
        for line in probe.stdout.strip().split("\n"):
            if "=" in line:
                k, v = line.split("=", 1)
                if k.strip() == "duration":
                    duration = float(v.strip())
                    break
    except Exception as e:
        logger.warning("[Mimo ASR] 无法获取音频时长: %s, 不分段", e)
        return [audio_path]

    if duration <= chunk_sec * 0.8:  # 超过 20s 就分段，留足 token 余量
        # 够短，不需要分段
        return [audio_path]

    logger.info("[Mimo ASR] 音频时长 %.0fs > %ds，开始分段...", duration, chunk_sec)

    from utils import get_task_dir
    task_dir = get_task_dir(task_id)
    chunks_dir = task_dir / "chunks"
    chunks_dir.mkdir(exist_ok=True, parents=True)

    chunk_paths = []
    start = 0.0
    idx = 0
    while start < duration - 2:  # 最后留 2s 余量
        idx += 1
        out_path = chunks_dir / f"chunk_{idx:03d}.mp3"
        cmd = [
            FFMPEG_PATH,
            "-i", str(audio_path),
            "-ss", str(start),
            "-t", str(chunk_sec),
            "-ar", "16000", "-ac", "1", "-b:a", "64k",
            "-y", str(out_path),
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=60,
        )
        if result.returncode != 0:
            logger.error("[Mimo ASR] 分段失败 (段 %d): %s", idx, result.stderr[-200:])
            continue
        if out_path.exists():
            chunk_paths.append(out_path)
        start += chunk_sec

    if not chunk_paths:
        logger.warning("[Mimo ASR] 分段全部失败，回退到原始文件")
        return [audio_path]

    logger.info("[Mimo ASR] 切分为 %d 段", len(chunk_paths))
    return chunk_paths


def _compress_for_asr(audio_path: Path, task_id: str) -> Path:
    """
    用 FFmpeg 将音频压缩到适合 ASR 的大小（目标 < 10MB）。

    策略：16kHz 单声道 64kbit/s MP3 —— 对语音识别来说足够了。
    压缩后的文件放在原音频同目录下，命名为 audio_compressed.mp3。
    """
    from utils import get_task_dir
    task_dir = get_task_dir(task_id)
    output_path = task_dir / "audio_compressed.mp3"

    cmd = [
        FFMPEG_PATH,
        "-i", str(audio_path),
        "-ar", "16000",          # 16kHz 采样率（语音识别标准）
        "-ac", "1",              # 单声道
        "-b:a", "64k",           # 64kbps 比特率
        "-y",                   # 覆盖
        str(output_path),
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )

    if result.returncode != 0:
        logger.error("[Mimo ASR] FFmpeg 压缩失败: %s", result.stderr[-300:])
        raise RuntimeError(f"音频压缩失败: {result.stderr[-200:]}")

    if not output_path.exists():
        raise RuntimeError("压缩完成但输出文件不存在")

    return output_path
