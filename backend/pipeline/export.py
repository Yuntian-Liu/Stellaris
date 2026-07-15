"""
管线第 4 步：将识别结果导出为 srt 和 txt 格式
"""
from pathlib import Path


def segments_to_srt(segments: list[dict]) -> str:
    """
    将 ASR/CC 字幕的 segments 列表转换为 SRT 格式
    segment 结构: {"start": float(秒), "end": float(秒), "text": str}
    """
    lines = []
    for i, seg in enumerate(segments, 1):
        start_srt = _seconds_to_srt_time(seg["start"])
        end_srt = _seconds_to_srt_time(seg["end"])
        lines.append(str(i))
        lines.append(f"{start_srt} --> {end_srt}")
        lines.append(seg["text"])
        lines.append("")  # 空行分隔
    return "\n".join(lines)


def segments_to_txt(segments: list[dict]) -> str:
    """
    将 segments 导出为纯文本（只有文字内容）
    """
    return "\n".join(seg["text"] for seg in segments)


def bilibili_subtitle_to_segments(body: dict) -> list[dict]:
    """
    将 B站 CC 字幕 JSON 格式转换为统一 segments 格式
    B站格式: {"body": [{"from": float, "to": float, "content": str}]}
    """
    if isinstance(body, list):
        items = body
    elif isinstance(body, dict):
        items = body.get("body", [])
    else:
        return []

    segments = []
    for item in items:
        segments.append({
            "start": item.get("from", 0),
            "end": item.get("to", 0),
            "text": item.get("content", ""),
        })
    return segments


def save_exports(task_id: str, srt_content: str, txt_content: str) -> dict:
    """
    保存 srt/txt 到任务目录，返回路径信息
    """
    from utils import get_task_dir

    task_dir = get_task_dir(task_id)
    srt_path = task_dir / "output.srt"
    txt_path = task_dir / "output.txt"

    srt_path.write_text(srt_content, encoding="utf-8")
    txt_path.write_text(txt_content, encoding="utf-8")

    return {
        "srt_path": srt_path,
        "txt_path": txt_path,
    }


def _seconds_to_srt_time(seconds: float) -> str:
    """将秒数转换为 SRT 时间格式 HH:MM:SS,mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
