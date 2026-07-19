"""
管线第 1 步：下载视频 / 接收文件 → 提取音频

B站链接走 pipeline.bilibili_api 纯 API 直连（绕开 yt-dlp 网页抓取被
412 风控的问题，数据中心 IP 可用）；其他站点走 yt-dlp。
"""
import subprocess
import sys
from pathlib import Path

from config import FFMPEG_PATH, BILIBILI_FORMAT, DOWNLOAD_TIMEOUT_SEC
from pipeline.bilibili_api import (
    is_bilibili_url, resolve_bvid, fetch_video_info, fetch_audio_url,
    download_to_file,
)
from utils import get_task_dir


def download_bilibili(url: str, task_id: str, sessdata: str | None = None) -> dict:
    """
    下载视频音频。B站走 API 直连，其他站点走 yt-dlp。
    返回: {"audio_path": Path, "video_title": str}
    """
    if is_bilibili_url(url):
        return _download_bilibili_via_api(url, task_id, sessdata)
    return _download_via_ytdlp(url, task_id, sessdata)


def _download_bilibili_via_api(
    url: str, task_id: str, sessdata: str | None
) -> dict:
    """B站 API 直连：view 拿 cid → playurl 拿音频直链 → 下载 m4s → ffmpeg 转 mp3"""
    task_dir = get_task_dir(task_id)
    bvid = resolve_bvid(url, sessdata)
    info = fetch_video_info(bvid, sessdata)
    audio_url = fetch_audio_url(bvid, info["cid"], sessdata)

    m4s_path = task_dir / "audio.m4s"
    download_to_file(audio_url, m4s_path, sessdata,
                     timeout=DOWNLOAD_TIMEOUT_SEC)

    # m4s → mp3（与 extract_audio_from_file 同款参数）
    audio_path = task_dir / "audio.mp3"
    cmd = [
        FFMPEG_PATH,
        "-i", str(m4s_path),
        "-vn",
        "-acodec", "libmp3lame",
        "-ab", "192k",
        "-y",
        str(audio_path),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=300,
    )
    m4s_path.unlink(missing_ok=True)     # 原始流用完即删，只留 mp3
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg 转码失败: {result.stderr[-500:]}")

    return {"audio_path": audio_path, "video_title": info["title"]}


def _download_via_ytdlp(
    url: str, task_id: str, sessdata: str | None
) -> dict:
    """yt-dlp 通用路径（非 B站站点；B站网页抓取在数据中心 IP 会被 412）"""
    task_dir = get_task_dir(task_id)
    audio_path = task_dir / "audio.mp3"

    # yt-dlp 命令：只下载最佳音频，转码为 mp3
    # --write-info-json 顺手落一份元数据，用于取真实视频标题
    # （注意：--print 会让 yt-dlp 跳过下载，不能用于此处）
    cmd = [
        sys.executable, "-m", "yt_dlp",   # 用当前解释器跑 yt_dlp 模块（venv 隔离，不依赖系统 PATH）
        "-x",                          # 只提取音频
        "--audio-format", "mp3",
        "--audio-quality", "0",        # 最佳音质
        "-o", str(audio_path.with_suffix(".%(ext)s")),
        "--ffmpeg-location", FFMPEG_PATH,
        "--no-playlist",                # 不下载播放列表
        "--write-info-json",            # 写元数据 JSON（取标题用）
        # ── 反爬绕过（不依赖用户 cookie,通用解法）──
        # 1. 最新版 Chrome UA,模拟真实浏览器
        "--user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "--referer", "https://www.bilibili.com/",
        "--add-header", "Accept-Language:zh-CN,zh;q=0.9,en;q=0.8",
        # 2. 模拟完整的浏览器请求头,避免被特征识别为爬虫
        "--add-header", "Origin:https://www.bilibili.com",
        "--add-header", "Sec-Ch-Ua:\"Chromium\";v=\"128\", \"Not;A=Brand\";v=\"24\", \"Google Chrome\";v=\"128\"",
        "--add-header", "Sec-Fetch-Dest:document",
        "--add-header", "Sec-Fetch-Mode:navigate",
        "--add-header", "Sec-Fetch-Site:same-origin",
        # 3. 用 yt-dlp 原生的 B站 extractor 而不是通用抓取
        "--extractor-args", "bilibili:webpage=1"
    ]
    # 带用户 B站登录 cookie（SESSDATA），绕过反爬 + 能看会员视频
    if sessdata:
        cmd += ["--add-header", f"Cookie:SESSDATA={sessdata}"]
    cmd.append(url)

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
        (p for p in task_dir.glob("audio.*") if p.suffix != ".json"), None
    )
    if not actual_audio:
        raise RuntimeError("下载完成但未找到音频文件")

    return {
        "audio_path": actual_audio,
        "video_title": _read_title_from_info_json(task_dir),
    }


def probe_bilibili_info(url: str, sessdata: str | None = None) -> dict:
    """
    只拉取视频元数据（不下载），用于提取前的成本预估。
    B站走 API 直连，其他站点走 yt-dlp。
    返回: {"title": str, "duration_sec": float}
    """
    if is_bilibili_url(url):
        info = fetch_video_info(resolve_bvid(url, sessdata), sessdata)
        return {"title": info["title"], "duration_sec": info["duration_sec"]}
    return _probe_via_ytdlp(url, sessdata)


def _probe_via_ytdlp(url: str, sessdata: str | None = None) -> dict:
    """yt-dlp 通用元数据探测（非 B站站点）"""
    import json

    cmd = [
        sys.executable, "-m", "yt_dlp",   # 用当前解释器跑 yt_dlp 模块（venv 隔离，不依赖系统 PATH）
        "--dump-single-json",      # 输出完整 JSON 元数据
        "--no-playlist",
        "--skip-download",         # 不下载任何内容
        "--ffmpeg-location", FFMPEG_PATH,
        # 反爬：同 download_bilibili（不依赖 cookie,通用解法）
        "--user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "--referer", "https://www.bilibili.com/",
        "--add-header", "Accept-Language:zh-CN,zh;q=0.9,en;q=0.8",
        "--add-header", "Origin:https://www.bilibili.com",
        "--add-header", "Sec-Ch-Ua:\"Chromium\";v=\"128\", \"Not;A=Brand\";v=\"24\", \"Google Chrome\";v=\"128\"",
        "--add-header", "Sec-Fetch-Dest:document",
        "--add-header", "Sec-Fetch-Mode:navigate",
        "--add-header", "Sec-Fetch-Site:same-origin",
    ]
    if sessdata:
        cmd += ["--add-header", f"Cookie:SESSDATA={sessdata}"]
    cmd.append(url)

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,                 # 元数据探测不应太久
    )

    if result.returncode != 0:
        raise RuntimeError(f"无法解析视频信息: {result.stderr[-300:]}")

    try:
        info = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("视频信息解析失败（返回格式异常）")

    duration = info.get("duration")
    if duration is None:
        raise RuntimeError("未能获取视频时长")

    return {
        "title": info.get("title") or "Unknown Title",
        "duration_sec": float(duration),
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


def _read_title_from_info_json(task_dir: Path) -> str:
    """读取 yt-dlp --write-info-json 落盘的元数据取真实标题，读完即删"""
    import json

    info_files = list(task_dir.glob("*.info.json"))
    if not info_files:
        return "Unknown Title"

    title = "Unknown Title"
    for info_file in info_files:
        try:
            data = json.loads(info_file.read_text(encoding="utf-8"))
            if data.get("title"):
                title = data["title"][:200]  # 截断过长标题
        except (json.JSONDecodeError, OSError):
            pass
        finally:
            info_file.unlink(missing_ok=True)  # 元数据文件用完即删
    return title
