"""
管线第 3 步：ASR 语音识别（多引擎）

- 默认引擎 mimo_chat：小米 Mimo ASR（model: mimo-v2.5-asr），OpenAI 兼容 chat completions，
  音频 base64 经 input_audio 发送。中文/英文。
- beta 引擎 qwen_audio_sync：阿里百炼 qwen-audio-3.1-asr-flash（V1.5.0），DashScope
  multimodal-generation HTTP 接口 + SSE 流式收逐句时间戳，httpx 直调零新依赖。31 语种自动识别。

入口统一走 transcribe(audio_path, task_id, asr_key)；模型目录见 pipeline/asr_models.py。
"""
import os
import base64
import json
import logging
import subprocess
from pathlib import Path

import httpx
from openai import OpenAI

from config import (
    MIMO_API_KEY, MIMO_BASE_URL, MIMO_MODEL, FFMPEG_PATH, FFPROBE_PATH,
    DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL,
)
from pipeline.llm import _record   # V1.2.2 调用健康埋点（复用 LLM 的落库桥接）

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


def _active_asr_model() -> str:
    """当前生效的 ASR 模型名（V1.1.0 模型仓库缓存，切换即时生效）"""
    from model_store import get_asr_model
    return get_asr_model()


# ===== 统一入口（V1.5.0 多模型）=====

def transcribe(audio_path: Path, task_id: str, asr_key: str | None = None,
               diarize: bool = False) -> dict:
    """ASR 统一入口：按目录分发到引擎适配器。asr_key 非法/为空 → 默认 mimo（行为不变）。
    diarize=True 仅 qwen 引擎支持（其他引擎静默忽略）。
    返回 {segments, full_text, source, asr_usage}；asr_usage 仅 token 计费引擎（qwen）有值，
    供管线结算时算真实成本（路线 1：用户按 时长×倍率 扣分钟，token 只记账）。
    diarize 时 segment 带 speaker 字段（1 起）。"""
    from pipeline.asr_models import ASR_MODELS, DEFAULT_ASR_KEY
    choice = ASR_MODELS.get(asr_key or "") or ASR_MODELS[DEFAULT_ASR_KEY]
    if choice["engine"] == "qwen_audio_sync":
        return _transcribe_qwen(audio_path, task_id, choice, diarize=diarize)
    result = transcribe_with_mimo(audio_path, task_id)
    result["asr_usage"] = None
    return result


# ===== Qwen Audio 引擎（V1.5.0 beta；DashScope HTTP + SSE 逐句时间戳）=====

QWEN_CHUNK_SEC = 180          # 单次调用 ≤5min，取 180s 留足余量
_QWEN_CTX_MAX_CHARS = 400     # 上下文增强：每轮上下文文本总长度上限（官方文档）


def _transcribe_qwen(audio_path: Path, task_id: str, choice: dict, diarize: bool = False) -> dict:
    """调用 qwen-audio-3.1-asr-flash 转写。SSE 事件流取最终事件的全量词级时间戳重组句子；
    第 2 段起携带上一段文本作上下文增强（提升跨段衔接准确率）。
    diarize=True 开启说话人分离：返回 output.sentences[] 按说话人回合组织（带 speaker_id +
    每回合 words[]），每回合内再按词重组字幕条目，segment 带 speaker（1 起）。"""
    key = os.environ.get("DASHSCOPE_API_KEY") or DASHSCOPE_API_KEY
    if not key:
        raise RuntimeError("DASHSCOPE_API_KEY 未设置，无法使用多语言模型")
    model_name = choice["model_name"]
    url = f"{DASHSCOPE_BASE_URL}/api/v1/services/aigc/multimodal-generation/generation"
    logger.info("[Qwen ASR] 开始识别: %s (%.1fMB)%s (task=%s)",
                audio_path.name, audio_path.stat().st_size / (1024 * 1024),
                " [说话人分离]" if diarize else "", task_id)

    # 分段（复用 Mimo 的切分设施，段长 180s）
    chunks = _split_audio_if_needed(audio_path, task_id, chunk_sec=QWEN_CHUNK_SEC)

    all_segments = []
    offset_sec = 0.0
    total_usage = {"input_tokens": 0, "output_tokens": 0}
    prev_text = None   # 上下文增强：上一段识别文本

    for idx, chunk_path in enumerate(chunks):
        chunk_duration = probe_media_duration(chunk_path)   # 实际段长，偏移累加比固定值准

        logger.info("[Qwen ASR] 处理段 %d/%d (%.0fs, 偏移 %.0fs)...",
                    idx + 1, len(chunks), chunk_duration, offset_sec)
        try:
            sentences, usage = _qwen_sse_call(chunk_path, url, key, model_name,
                                              prev_text, f"{task_id}_chunk{idx}",
                                              diarize=diarize)
        except Exception as e:
            logger.error("[Qwen ASR] 段 %d 识别失败 (task=%s): %s", idx + 1, task_id, e)
            _record("asr", model_name, None, None, True, f"{task_id}_chunk{idx}")
            raise

        empty = not sentences
        _record("asr", model_name, usage, None, empty, f"{task_id}_chunk{idx}")
        total_usage["input_tokens"] += (usage or {}).get("input_tokens") or 0
        total_usage["output_tokens"] += (usage or {}).get("output_tokens") or 0

        for s in sentences:
            seg = {
                "start": s["begin_time"] / 1000 + offset_sec,
                "end": (s.get("end_time") or s["begin_time"]) / 1000 + offset_sec,
                "text": s["text"].strip(),
            }
            if s.get("speaker") is not None:
                seg["speaker"] = s["speaker"]
            all_segments.append(seg)
        if sentences:
            prev_text = "".join(s["text"] for s in sentences)
        # 探不到时长时按标称段长推进（保险分支，正常不会发生）
        offset_sec += chunk_duration if chunk_duration > 0 else QWEN_CHUNK_SEC

        if chunk_path != audio_path:
            chunk_path.unlink(missing_ok=True)

    full_text = " ".join(seg["text"] for seg in all_segments)
    logger.info("[Qwen ASR] 识别完成: %d 段, %d 字符, tokens=%d+%d (task=%s)",
                len(chunks), len(full_text),
                total_usage["input_tokens"], total_usage["output_tokens"], task_id)
    return {
        "segments": all_segments,
        "full_text": full_text,
        "source": "asr_qwen",
        "asr_usage": total_usage,
    }


def _qwen_sse_call(chunk_path: Path, url: str, api_key: str, model: str,
                   prev_text: str | None, log_tag: str,
                   diarize: bool = False) -> tuple[list[dict], dict | None]:
    """单段 SSE 调用。返回 (句列表[{begin_time,end_time,text,speaker?}], usage)。
    重试一次应对 5xx/网络抖动；其他错误直接抛（任务失败零扣费）。"""
    audio_b64 = base64.b64encode(chunk_path.read_bytes()).decode("utf-8")
    messages = []
    if prev_text:
        # 上下文增强（官方能力）：前段识别结果作 input_text，音频消息必须在最后
        messages.append({"role": "user", "content": [
            {"type": "input_text", "text": prev_text[-_QWEN_CTX_MAX_CHARS:]}]})
    messages.append({"role": "user", "content": [
        {"type": "input_audio",
         "input_audio": {"data": f"data:audio/mpeg;base64,{audio_b64}"}}]})
    parameters = {"format": "mp3", "sample_rate": "16000"}
    if diarize:
        parameters["speaker_diarization_enabled"] = True
    payload = {
        "model": model,
        "input": {"messages": messages},
        "parameters": parameters,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-SSE": "enable",
    }

    last_err = None
    for attempt in (1, 2):
        try:
            return _qwen_sse_once(url, headers, payload, log_tag, diarize=diarize)
        except Exception as e:
            last_err = e
            if attempt == 1:
                logger.warning("[Qwen ASR] 段调用失败，重试一次 (%s): %s", log_tag, str(e)[:150])
    raise last_err


def _qwen_sse_once(url: str, headers: dict, payload: dict, log_tag: str,
                   diarize: bool = False) -> tuple[list[dict], dict | None]:
    """单次 SSE 请求（同步 httpx；调用方在线程池里）。

    实测协议（2026-09-29 真机探测，与文档示例有出入，以此为准）：
    - 每个事件的 output.sentence 是"从音频起点到当前"的累积快照，不是独立句子——
      不能逐句收集（会把文本重复拼接）
    - 最终事件的 sentence.words[] 才是全量词级时间戳（fixed=true，标点挂在词尾），
      句子由我们按标点/停顿重组
    - 说话人分离（diarize）时最终事件改为 output.sentences[]：按说话人回合组织，
      每回合带 speaker_id + 该回合的 words[]，回合内仍由我们重组字幕条目
    - usage 仅最终事件带 input/output/total_tokens；中间事件只有 duration
    - 错误以 event:error + data:{code,message} 下发，HTTP 状态仍是 200，必须解析
    """
    final_words: list[dict] = []
    final_turns: list[dict] = []
    final_text = ""
    usage: dict | None = None
    with httpx.stream("POST", url, headers=headers, json=payload, timeout=300) as resp:
        if resp.status_code != 200:
            body = resp.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"Qwen ASR HTTP {resp.status_code}: {body}")
        event_name = None
        for line in resp.iter_lines():
            if line.startswith("event:"):
                event_name = line[6:].strip()
                continue
            if not line.startswith("data:"):
                continue
            try:
                data = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if event_name == "error" or ("code" in data and "output" not in data):
                raise RuntimeError(f"Qwen ASR 错误: {data.get('message') or data}")
            event_name = None
            output = data.get("output") or {}
            if output.get("sentences"):
                final_turns = output["sentences"]      # 说话人分离模式：回合列表（覆盖式保留）
            sent = output.get("sentence") or {}
            if sent.get("words"):
                final_words = sent["words"]            # 越往后越全，最终事件覆盖式保留
            if output.get("text"):
                final_text = output["text"]
            u = data.get("usage")
            if u and u.get("total_tokens") is not None:
                usage = u

    # 说话人分离：回合 → 回合内按词重组字幕条目，条目带 speaker（1 起，展示友好）
    if diarize and final_turns:
        sentences: list[dict] = []
        for turn in final_turns:
            spk = turn.get("speaker_id")
            turn_words = turn.get("words") or []
            if turn_words:
                for s in _words_to_sentences(turn_words):
                    s["speaker"] = (spk + 1) if isinstance(spk, int) else None
                    sentences.append(s)
            elif (turn.get("text") or "").strip():
                sentences.append({
                    "begin_time": turn.get("begin_time") or 0,
                    "end_time": turn.get("end_time") or turn.get("begin_time") or 0,
                    "text": turn["text"].strip(),
                    "speaker": (spk + 1) if isinstance(spk, int) else None,
                })
        if sentences:
            return sentences, usage

    if not final_words:
        if final_text:
            # 兜底：有全文无词级时间戳 → 单段返回（SRT 时间轴由调用方退化处理）
            logger.warning("[Qwen ASR] 无词级时间戳，退化为整段文本 (%s)", log_tag)
            return [{"begin_time": 0, "end_time": 0, "text": final_text.strip()}], usage
        raise RuntimeError(f"Qwen ASR 未返回有效内容 ({log_tag})")
    if usage is None:
        logger.warning("[Qwen ASR] 未收到 usage，成本估算为 0 (%s)", log_tag)
    return _words_to_sentences(final_words), usage


def _words_to_sentences(words: list[dict]) -> list[dict]:
    """词级碎片重组为句子（begin_time/end_time 毫秒）。
    断句规则：句末标点（。！？!?… 或英文 .）必断；词间停顿 >1.2s 断；
    句子已超 60 字时遇顿号/逗号也断（SRT 可读性）。"""
    sentences: list[dict] = []
    cur_words: list[dict] = []
    cur_text: list[str] = []

    def flush():
        if cur_words:
            sentences.append({
                "begin_time": cur_words[0]["begin_time"],
                "end_time": cur_words[-1].get("end_time") or cur_words[-1]["begin_time"],
                "text": "".join(cur_text).strip(),
            })

    for i, w in enumerate(words):
        piece = (w.get("text") or "")
        punct = (w.get("punctuation") or "").strip()
        cur_words.append(w)
        cur_text.append(piece + punct)
        text_len = sum(len(t) for t in cur_text)
        terminal = any(p in punct for p in "。！？!?…") or punct.endswith(".")
        gap = (words[i + 1].get("begin_time", 0) - (w.get("end_time") or 0)) if i + 1 < len(words) else 0
        clause_break = any(p in punct for p in "、，,") and text_len > 60
        if terminal or gap > 1200 or clause_break:
            flush()
            cur_words, cur_text = [], []
    flush()
    return [s for s in sentences if s["text"]]


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
                model=_active_asr_model(),
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
            # 解析与调用同一观测边界（Codex 08：解析异常也要记事件）
            result = _parse_mimo_response(completion, f"{task_id}_chunk{idx}")
        except Exception as e:
            logger.error("[Mimo ASR] 段 %d 识别失败 (task=%s): %s", idx + 1, task_id, e)
            _record("asr", _active_asr_model(), None, None, True, f"{task_id}_chunk{idx}")
            raise

        # V1.2.2 调用健康埋点：ASR 也进 llm_call_events（空段按 full_text 判——空 text segment 不算有效内容）
        _record("asr", _active_asr_model(),
                result.get("_raw_usage") or {},
                completion.choices[0].finish_reason if completion.choices else None,
                not (result.get("full_text") or "").strip(), f"{task_id}_chunk{idx}")
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


def probe_media_duration(path: Path) -> float:
    """用 ffprobe 探测媒体文件时长（秒）；失败/无法识别返回 0.0。
    音频/视频通用——upload 路由探上传视频时长做计费，_split_audio_if_needed 探音频时长做分段，
    共用此函数。"""
    try:
        probe = subprocess.run(
            [FFPROBE_PATH, "-i", str(path), "-show_entries", "format=duration", "-v", "quiet"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=10,
        )
        # ffprobe 输出: [FORMAT]\nduration=xxx\n[/FORMAT]，提取 duration= 那一行
        for line in probe.stdout.strip().split("\n"):
            if "=" in line:
                k, v = line.split("=", 1)
                if k.strip() == "duration":
                    try:
                        return float(v.strip())
                    except ValueError:
                        return 0.0
        return 0.0
    except Exception as e:
        logger.warning("[ASR] probe_media_duration 探测失败 %s: %s", path, e)
        return 0.0


def _split_audio_if_needed(audio_path: Path, task_id: str, chunk_sec: int = 50) -> list[Path]:
    """
    双引擎共用：超出单次调用上限时用 FFmpeg 切分为小段
    （Mimo 受 8192 token 限用 25s；qwen 受单次 5min 限用 180s）。

    简单策略：按固定时长切分，最后一段可能较短。
    返回分片文件路径列表（调用方负责清理）。
    """
    duration = probe_media_duration(audio_path)
    if duration <= 0:
        logger.warning("[ASR] 无法获取音频时长，不分段")
        return [audio_path]

    if duration <= chunk_sec * 0.8:  # 留足余量
        # 够短，不需要分段
        return [audio_path]

    logger.info("[ASR] 音频时长 %.0fs > %ds，开始分段...", duration, chunk_sec)

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
            logger.error("[ASR] 分段失败 (段 %d): %s", idx, result.stderr[-200:])
            continue
        if out_path.exists():
            chunk_paths.append(out_path)
        start += chunk_sec

    if not chunk_paths:
        logger.warning("[ASR] 分段全部失败，回退到原始文件")
        return [audio_path]

    logger.info("[ASR] 切分为 %d 段", len(chunk_paths))
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
        logger.error("[ASR] FFmpeg 压缩失败: %s", result.stderr[-300:])
        raise RuntimeError(f"音频压缩失败: {result.stderr[-200:]}")

    if not output_path.exists():
        raise RuntimeError("压缩完成但输出文件不存在")

    return output_path
