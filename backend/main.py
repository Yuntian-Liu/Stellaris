"""
Stellaris 后端入口 — FastAPI 应用
路由：健康检查 / 提交任务 / 查询状态 / 下载结果
"""
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from config import (
    MAX_CONCURRENT_TASKS,
    SPEECH_CHARS_PER_MIN, CHARS_PER_TOKEN, LLM_TOKEN_ROUNDTRIP_FACTOR,
)
from utils import generate_task_id, cleanup_temp_files, cleanup_old_tasks, check_disk_space
from models import (
    SubmitRequest, TaskResponse, TaskStatus,
    HealthResponse, TaskSource,
    EstimateRequest, EstimateResponse,
)
from pipeline.download import download_bilibili, extract_audio_from_file, probe_bilibili_info
from pipeline.subtitle import fetch_cc_subtitle
from pipeline.asr import transcribe_with_mimo
from pipeline.llm import segment_text, text_to_markdown, summarize_text
from pipeline.export import (
    segments_to_srt, segments_to_txt,
    bilibili_subtitle_to_segments, save_exports,
)


# ===== 内存中的任务存储（生产环境应换 Redis）=====
tasks: dict[str, dict] = {}
running_tasks: set = set()  # 正在运行的任务 ID 集合

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动/关闭时的初始化/清理"""
    print("[Stellaris] starting up...")
    # 启动时清理上次进程留下的过期任务文件
    cleaned = cleanup_old_tasks(max_age_hours=1)
    if cleaned:
        print(f"[Stellaris] 启动清理：删除 {cleaned} 个过期任务目录")
    # 起后台定时清理任务（每 10 分钟扫一次）
    cleanup_task = asyncio.create_task(_periodic_cleanup())
    yield
    # 关闭：取消定时任务 + 清理所有临时文件
    cleanup_task.cancel()
    for task_id in list(tasks.keys()):
        cleanup_temp_files(task_id)
    print("[Stellaris] shut down. Temp files cleaned.")


async def _periodic_cleanup():
    """后台定时清理：每 10 分钟扫描并清理超过 1 小时的任务文件。"""
    while True:
        await asyncio.sleep(600)
        try:
            cleaned = cleanup_old_tasks(max_age_hours=1)
            if cleaned:
                logger.info("[Cleanup] 定时清理：删除 %d 个过期任务", cleaned)
        except Exception as e:
            logger.error("[Cleanup] 定时清理失败: %s", e)


app = FastAPI(
    title="Stellaris",
    description="Turning voices into words you can read.",
    version="0.0.1-nebula",
    lifespan=lifespan,
)

# CORS（前端开发时需要）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应限制为实际域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===== 路由 =====

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查"""
    return HealthResponse()


@app.post("/api/estimate", response_model=EstimateResponse)
async def estimate_cost(request: EstimateRequest):
    """
    提取前成本预估：只拉视频元数据（不下载），
    估算转写字数与 LLM 语义分段 tokens，让用户确认后再提交。
    """
    try:
        info = await asyncio.to_thread(probe_bilibili_info, request.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    duration_min = info["duration_sec"] / 60
    est_chars = int(duration_min * SPEECH_CHARS_PER_MIN)
    est_tokens = int(est_chars / CHARS_PER_TOKEN * LLM_TOKEN_ROUNDTRIP_FACTOR)

    return EstimateResponse(
        title=info["title"],
        duration_sec=info["duration_sec"],
        est_char_count=est_chars,
        est_llm_tokens=est_tokens,
    )


@app.post("/api/submit", response_model=TaskResponse)
async def submit_task(
    request: SubmitRequest,
    background_tasks: BackgroundTasks,
):
    """
    提交新的字幕提取任务
    支持 B站链接 或 文件上传
    """
    # 磁盘空间检查
    if not check_disk_space():
        raise HTTPException(status_code=503, detail="磁盘空间不足，请稍后重试")

    task_id = generate_task_id()

    # 初始化任务状态
    tasks[task_id] = {
        "task_id": task_id,
        "status": TaskStatus.PENDING,
        "progress": 0,
        "source": request.source.value,
        "url": request.url,
        "sessdata": request.sessdata,
    }

    # 后台执行管线
    background_tasks.add_task(
        run_pipeline,
        task_id,
        request.source,
        request.url,
        request.sessdata,
    )

    return TaskResponse(
        task_id=task_id,
        status=TaskStatus.PENDING,
        message="任务已提交，正在处理中...",
    )


@app.post("/api/upload", response_model=TaskResponse)
async def upload_file(
    file: UploadFile = File(...),
    sessdata: str | None = None,
    background_tasks: BackgroundTasks = None,
):
    """上传视频文件提取字幕"""
    if not check_disk_space():
        raise HTTPException(status_code=503, detail="磁盘空间不足")

    task_id = generate_task_id()

    # 保存上传的文件
    from utils import get_task_dir
    task_dir = get_task_dir(task_id)
    file_path = task_dir / f"upload_{file.filename}"

    content = await file.read()
    file_path.write_bytes(content)

    tasks[task_id] = {
        "task_id": task_id,
        "status": TaskStatus.PENDING,
        "progress": 0,
        "source": TaskSource.FILE_UPLOAD.value,
        "file_path": str(file_path),
        "sessdata": sessdata,
    }

    background_tasks.add_task(
        run_pipeline_from_file,
        task_id,
        file_path,
        sessdata,
    )

    return TaskResponse(
        task_id=task_id,
        status=TaskStatus.PENDING,
        message=f"文件 {file.filename} 已接收，正在处理...",
    )


@app.get("/api/task/{task_id}", response_model=TaskResponse)
async def get_task_status(task_id: str):
    """查询任务状态和结果"""
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    return TaskResponse(**task)


@app.delete("/api/task/{task_id}", response_model=TaskResponse)
async def delete_task(task_id: str):
    """
    用户主动清理任务数据（删除临时文件，不可恢复）。
    任务状态保留在内存（前端刷新仍能看到 cleaned 标记）。
    """
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    cleanup_temp_files(task_id)
    task["cleaned"] = True
    logger.info("[Cleanup] 用户主动清理: %s", task_id)

    return TaskResponse(**task)


@app.get("/api/download/{task_id}/{format}")
async def download_result(task_id: str, format: str):
    """下载生成的字幕文件（srt/txt/md）"""
    if format not in ("srt", "txt", "md"):
        raise HTTPException(status_code=400, detail="格式仅支持 srt、txt 或 md")

    from utils import get_task_dir
    task_dir = get_task_dir(task_id)
    file_path = task_dir / f"output.{format}"

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在（任务可能尚未完成或该格式未生成）")

    media_type_map = {
        "txt": "text/plain",
        "srt": "application/x-subrip",
        "md": "text/markdown",
    }
    return FileResponse(
        path=str(file_path),
        filename=f"stellaris-{task_id}.{format}",
        media_type=media_type_map[format],
    )


@app.post("/api/export_md/{task_id}", response_model=TaskResponse)
async def export_markdown(
    task_id: str,
    background_tasks: BackgroundTasks,
):
    """
    触发 Markdown 导出（增值功能，用户主动调用）
    基于原始转录文本用 LLM 转写为结构化 Markdown，异步生成。
    """
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    if task.get("status") != TaskStatus.COMPLETED:
        raise HTTPException(status_code=409, detail="任务尚未完成，无法导出 Markdown")

    if not task.get("raw_text"):
        raise HTTPException(status_code=500, detail="原始文本缺失，无法导出")

    # 已经生成过则直接返回
    if task.get("md_status") == "ready":
        return TaskResponse(**task)

    # 触发后台生成
    task["md_status"] = "generating"
    task["md_error"] = None
    background_tasks.add_task(_generate_md_background, task_id)

    return TaskResponse(**task)


@app.post("/api/summarize/{task_id}", response_model=TaskResponse)
async def summarize_task(
    task_id: str,
    background_tasks: BackgroundTasks,
):
    """
    触发内容总结概要（增值功能，用户主动调用）
    基于原始字幕文本用 LLM 生成结构化概要，异步生成。
    """
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    if task.get("status") != TaskStatus.COMPLETED:
        raise HTTPException(status_code=409, detail="任务尚未完成，无法生成总结")

    if not task.get("raw_text"):
        raise HTTPException(status_code=500, detail="原始文本缺失，无法生成总结")

    # 已经生成过则直接返回
    if task.get("summary_status") == "ready":
        return TaskResponse(**task)

    # 触发后台生成
    task["summary_status"] = "generating"
    task["summary_error"] = None
    background_tasks.add_task(_generate_summary_background, task_id)

    return TaskResponse(**task)


# ===== 核心管线（后台执行）=====

async def run_pipeline(
    task_id: str,
    source: TaskSource,
    url: str | None,
    sessdata: str | None,
):
    """B站链接的完整管线（async 包装，实际在线程池跑同步管线）"""
    import asyncio
    await asyncio.to_thread(_run_pipeline_sync, task_id, source, url, sessdata)


def _run_pipeline_sync(
    task_id: str,
    source: TaskSource,
    url: str | None,
    sessdata: str | None,
):
    """B站链接管线同步实现（放线程池跑，不阻塞事件循环）"""
    try:
        _update_status(task_id, TaskStatus.DOWNLOADING, 10)

        # ① 下载音频
        result = download_bilibili(url, task_id)
        audio_path = result["audio_path"]
        video_title = result["video_title"]
        _update_status(task_id, TaskStatus.EXTRACTING_AUDIO, 30)

        # ② 尝试 CC 字幕
        cc_segments = None
        if sessdata:
            _update_status(task_id, TaskStatus.FETCHING_SUBTITLES, 40)
            # 从 URL 提取 bvid/cid
            bvid, cid = _extract_bvid_cid(url)
            if bvid and cid:
                cc_subs = fetch_cc_subtitle(bvid, cid, sessdata)
                if cc_subs:
                    cc_segments = bilibili_subtitle_to_segments(cc_subs[0]["body"])

        # ③ ASR（如果没有 CC 字幕，或作为补充）
        if not cc_segments:
            _update_status(task_id, TaskStatus.TRANSCRIBING, 50)
            asr_result = transcribe_with_mimo(audio_path, task_id)
            segments = asr_result["segments"]
            subtitle_source = asr_result["source"]
        else:
            segments = cc_segments
            subtitle_source = "cc_subtitle"

        # ④ 拼接原始全文（供 LLM 分段 + 后续 MD 导出使用）
        raw_text = segments_to_txt(segments)

        # ⑤ LLM 语义分段（默认自动执行）
        _update_status(task_id, TaskStatus.TEXT_PROCESSING, 70)
        segmented_text = segment_text(raw_text, task_id)

        # ⑥ 导出（TXT 用分段后的，SRT 用原始 segments 保留时间轴）
        _update_status(task_id, TaskStatus.EXPORTING, 90)
        srt_content = segments_to_srt(segments)
        export_paths = save_exports(task_id, srt_content, segmented_text)

        # ✅ 完成
        _update_status(task_id, TaskStatus.COMPLETED, 100, extra={
            "video_title": video_title,
            "subtitle_srt": str(export_paths["srt_path"]),
            "subtitle_txt": segmented_text,        # 真实文本内容（前端预览用）
            "raw_text": raw_text,                   # 原始文本（MD/总结 API 用）
            "subtitle_source": subtitle_source,
            "md_status": "idle",                    # MD 尚未生成
            "summary_status": "idle",               # 总结尚未生成
            "completed_at": time.time(),            # 完成时间戳（自动清理用）
            "message": "完成！",
        })

    except Exception as e:
        _update_status(task_id, TaskStatus.FAILED, error=str(e))
        cleanup_temp_files(task_id)
    finally:
        running_tasks.discard(task_id)


async def run_pipeline_from_file(
    task_id: str,
    file_path: Path,
    sessdata: str | None,
):
    """文件上传管线（async 包装，实际在线程池跑同步管线）"""
    import asyncio
    await asyncio.to_thread(_run_pipeline_from_file_sync, task_id, file_path, sessdata)


def _run_pipeline_from_file_sync(
    task_id: str,
    file_path: Path,
    sessdata: str | None,
):
    """文件上传管线同步实现（放线程池跑，不阻塞事件循环）"""
    try:
        _update_status(task_id, TaskStatus.EXTRACTING_AUDIO, 20)

        # ① 抽音轨
        result = extract_audio_from_file(file_path, task_id)
        audio_path = result["audio_path"]
        video_title = result["video_title"]

        # ② ASR
        _update_status(task_id, TaskStatus.TRANSCRIBING, 50)
        asr_result = transcribe_with_mimo(audio_path, task_id)
        segments = asr_result["segments"]

        # ③ 拼接原始全文
        raw_text = segments_to_txt(segments)

        # ④ LLM 语义分段
        _update_status(task_id, TaskStatus.TEXT_PROCESSING, 70)
        segmented_text = segment_text(raw_text, task_id)

        # ⑤ 导出
        _update_status(task_id, TaskStatus.EXPORTING, 90)
        srt_content = segments_to_srt(segments)
        save_exports(task_id, srt_content, segmented_text)

        _update_status(task_id, TaskStatus.COMPLETED, 100, extra={
            "video_title": video_title,
            "subtitle_srt": "output.srt",
            "subtitle_txt": segmented_text,        # 真实文本内容（前端预览用）
            "raw_text": raw_text,                   # 原始文本（MD/总结 API 用）
            "subtitle_source": "asr_mimo",
            "md_status": "idle",
            "summary_status": "idle",
            "completed_at": time.time(),            # 完成时间戳（自动清理用）
            "message": "完成！",
        })

    except Exception as e:
        _update_status(task_id, TaskStatus.FAILED, error=str(e))
        cleanup_temp_files(task_id)
    finally:
        running_tasks.discard(task_id)


# ===== 内部辅助函数 =====

def _generate_summary_background(task_id: str):
    """后台生成内容总结：调用 LLM 将字幕浓缩为结构化概要。"""
    task = tasks.get(task_id)
    if not task:
        return

    raw_text = task.get("raw_text", "")
    try:
        summary_content = summarize_text(raw_text, task_id)

        # 保存到任务目录（方便后续可能的下载需求）
        from utils import get_task_dir
        task_dir = get_task_dir(task_id)
        summary_path = task_dir / "output_summary.md"
        summary_path.write_text(summary_content, encoding="utf-8")

        task["summary_status"] = "ready"
        task["summary_error"] = None
        task["summary_content"] = summary_content   # 直接带回前端展示
        logger.info("[Summary] 总结完成: %s (%d 字符)", task_id, len(summary_content))

    except Exception as e:
        task["summary_status"] = "failed"
        task["summary_error"] = str(e)
        logger.error("[Summary] 总结失败: %s - %s", task_id, e)


def _generate_md_background(task_id: str):
    """后台生成 Markdown：调用 LLM 将原始转录文本转为结构化 MD。"""
    task = tasks.get(task_id)
    if not task:
        return

    raw_text = task.get("raw_text", "")
    try:
        md_content = text_to_markdown(raw_text, task_id)

        # 保存到任务目录
        from utils import get_task_dir
        task_dir = get_task_dir(task_id)
        md_path = task_dir / "output.md"
        md_path.write_text(md_content, encoding="utf-8")

        task["md_status"] = "ready"
        task["md_error"] = None
        logger.info("[MD] 导出完成: %s (%d 字符)", task_id, len(md_content))

    except Exception as e:
        task["md_status"] = "failed"
        task["md_error"] = str(e)
        logger.error("[MD] 导出失败: %s - %s", task_id, e)


def _update_status(
    task_id: str,
    status: TaskStatus,
    progress: int = 0,
    *,
    extra: dict | None = None,
    error: str | None = None,
):
    """更新任务状态"""
    if task_id not in tasks:
        return
    tasks[task_id]["status"] = status
    tasks[task_id]["progress"] = progress
    if extra:
        tasks[task_id].update(extra)
    if error:
        tasks[task_id]["error"] = error


def _extract_bvid_cid(url: str) -> tuple[str | None, int | None]:
    """从 B站 URL 中粗略提取 BV 号和 cid（简化版）"""
    import re
    bv_match = re.search(r"(BV[A-Za-z0-9]+)", url)
    return (bv_match.group(1) if bv_match else None, None)
    # TODO: 完善 cid 提取（可能需要先调 API）
