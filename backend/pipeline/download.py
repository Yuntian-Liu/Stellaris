"""
管线第 1 步：下载视频 / 接收文件 → 提取音频
"""
import subprocess
from pathlib import Path

from config import FFMPEG_PATH, BILIBILI_FORMAT, DOWNLOAD_TIMEOUT_SEC
from utils import get_task_dir


def download_bilibili(url: str, task_id: str) -> dict:
    """
    用 yt-dlp 下载 B站视频的音频
    返回: {"audio_path": Path, "video_title": str}
    """
    task_dir = get_task_dir(task_id)
    audio_path = task_dir / "audio.mp3"

    # yt-dlp 命令：只下载最佳音频，转码为 mp3
    cmd = [
        "yt-dlp",
        "-x",                          # 只提取音频
        "--audio-format", "mp3",
        "--audio-quality", "0",        # 最佳音质
        "-o", str(audio_path.with_suffix(".%(ext)s")),
        "--ffmpeg-location", FFMPEG_PATH,
        "--no-playlist",                # 不下载播放列表
        url,
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",          # 显式 UTF-8，避免 Windows GBK 崩溃
        errors="replace",           # 替换无法解码的字符
        timeout=DOWNLOAD_TIMEOUT_SEC,
    )

    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp 下载失败: {result.stderr[-500:]}")

    # 找到实际输出的文件（扩展名可能不同）
    actual_audio = audio_path if audio_path.exists() else next(
        task_dir.glob("audio.*"), None
    )
    if not actual_audio:
        raise RuntimeError("下载完成但未找到音频文件")

    return {
        "audio_path": actual_audio,
        "video_title": _extract_title_from_output(result.stdout),
    }


def extract_audio_from_file(file_path: Path, task_id: str) -> dict:
    """
    从上传的视频文件中提取音频（FFmpeg）
    返回: {"audio_path": Path, "video_title": str}
    """
    task_dir = get_task_dir(task_id)
    audio_path = task_dir / "audio.mp3"

    cmd = [
        FFMPEG_PATH,
        "-i", str(file_path),
        "-vn",                    # 不要画面
        "-acodec", "libmp3lame",
        "-ab", "192k",            # 192kbps 足够语音识别
        "-y",                     # 覆盖已存在文件
        str(audio_path),
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
        raise RuntimeError(f"FFmpeg 抽音轨失败: {result.stderr[-500:]}")

    return {
        "audio_path": audio_path,
        "video_title": file_path.stem,
    }


def _extract_title_from_output(output: str | None) -> str:
    """从 yt-dlp 输出中提取视频标题"""
    if not output:
        return "Unknown Title"
    for line in output.split("\n"):
        if "[info]" in line and ("title" in line.lower() or len(line) > 20):
            # 简单启发式提取，后续可优化
            parts = line.split("]", 1)
            if len(parts) > 1:
                title_part = parts[1].strip()
                if title_part and not title_part.startswith("["):
                    return title_part[:200]  # 截断过长标题
    return "Unknown Title"
