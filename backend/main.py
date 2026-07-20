"""
Stellaris 后端入口 — FastAPI 应用
路由：健康检查 / 提交任务 / 查询状态 / 下载结果
"""
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from config import (
    MAX_CONCURRENT_TASKS,
    SPEECH_CHARS_PER_MIN, CHARS_PER_TOKEN, LLM_TOKEN_ROUNDTRIP_FACTOR,
)
from utils import generate_task_id, cleanup_temp_files, cleanup_old_tasks, check_disk_space, platform_label
from models import (
    SubmitRequest, TaskResponse, TaskStatus,
    HealthResponse, TaskSource,
    EstimateRequest, EstimateResponse,
    ChatRequest,
)
from pipeline.download import download_bilibili, extract_audio_from_file, probe_bilibili_info
from pipeline.subtitle import fetch_cc_subtitle
from pipeline.asr import transcribe_with_mimo
from pipeline.llm import segment_text, text_to_markdown, summarize_text, chat_with_subtitle_stream
from chat_store import save_chat_message, get_chat_history, delete_chat_messages
from history_store import save_task_record, list_task_records, delete_task_record
from diagnostics import attach_log_buffer, build_diagnostics
from pipeline.export import (
    segments_to_srt, segments_to_txt,
    bilibili_subtitle_to_segments, save_exports,
)

from database import init_db
from auth.router import router as auth_router
from auth.dependencies import get_current_user, get_current_user_optional
from auth.models import User
from stats_store import incr_stats, get_stats
from billing_store import (
    BILLING_TIERS, QUANTUM_PER_TOKEN_UNIT, round_tokens,
    get_billing, consume_minutes, consume_quantum, consume_gravity,
    check_minutes, check_quantum, check_gravity,
    check_and_consume_anon, exchange as billing_exchange,
    InsufficientError, SEG_TOKENS_PER_MIN,
)


# ===== 内存中的任务存储（生产环境应换 Redis）=====
tasks: dict[str, dict] = {}
running_tasks: set = set()  # 正在运行的任务 ID 集合

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动/关闭时的初始化/清理"""
    print("[Stellaris] starting up...")
    attach_log_buffer()   # 内存环形日志缓冲（诊断导出用）
    # 启动时清理上次进程留下的过期任务文件（联动删对话记录/历史记录）
    removed = cleanup_old_tasks(max_age_hours=1)
    if removed:
        print(f"[Stellaris] 启动清理：删除 {len(removed)} 个过期任务目录")
        for tid in removed:
            await delete_chat_messages(tid)
            await delete_task_record(tid)
    # 起后台定时清理任务（每 10 分钟扫一次）
    cleanup_task = asyncio.create_task(_periodic_cleanup())
    # 初始化数据库（建表）
    await init_db()
    print("[Stellaris] 数据库已就绪")
    yield
    # 关闭：取消定时任务 + 清理所有临时文件
    cleanup_task.cancel()
    for task_id in list(tasks.keys()):
        cleanup_temp_files(task_id)
    print("[Stellaris] shut down. Temp files cleaned.")


async def _periodic_cleanup():
    """后台定时清理：每 10 分钟扫描并清理超过 1 小时的任务文件（联动删对话/历史记录）。"""
    while True:
        await asyncio.sleep(600)
        try:
            removed = cleanup_old_tasks(max_age_hours=1)
            if removed:
                logger.info("[Cleanup] 定时清理：删除 %d 个过期任务", len(removed))
                for tid in removed:
                    await delete_chat_messages(tid)
                    await delete_task_record(tid)
        except Exception as e:
            logger.error("[Cleanup] 定时清理失败: %s", e)


app = FastAPI(
    title="Stellaris",
    description="Turning voices into words you can read.",
    version="0.7.0-rigel",
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

# ===== Auth 子模块路由 =====
app.include_router(auth_router)


# ===== 路由 =====

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查"""
    return HealthResponse()


@app.get("/api/config")
async def get_public_config():
    """前端公开配置（Turnstile site key 公开,secret 不返回）。
    运行时拿,避免 Vite build-time env 依赖（Zeabur 等平台 build 阶段拿不到 runtime env）。
    """
    from config import TURNSTILE_SITE_KEY, IS_PROD
    return {"turnstile_site_key": TURNSTILE_SITE_KEY, "is_prod": IS_PROD}


@app.post("/api/estimate", response_model=EstimateResponse)
async def estimate_cost(
    request: EstimateRequest,
    req: Request,
    current_user: User | None = Depends(get_current_user_optional),
):
    """
    提取前成本预估：只拉视频元数据（不下载），
    估算分钟 + 量子波消耗与当前余量，让用户确认后再提交（不扣费）。
    """
    import math
    try:
        info = await asyncio.to_thread(probe_bilibili_info, request.url, request.sessdata)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    duration_min = info["duration_sec"] / 60
    est_chars = int(duration_min * SPEECH_CHARS_PER_MIN)
    est_tokens = int(est_chars / CHARS_PER_TOKEN * LLM_TOKEN_ROUNDTRIP_FACTOR)
    est_minutes = max(1, math.ceil(duration_min))
    est_quantum = round_tokens(est_tokens, QUANTUM_PER_TOKEN_UNIT)

    resp = EstimateResponse(
        title=info["title"],
        duration_sec=info["duration_sec"],
        est_char_count=est_chars,
        est_llm_tokens=est_tokens,
        est_minutes=est_minutes,
        est_quantum=est_quantum,
    )

    # 登录用户：返回余量与可负担判断
    if current_user:
        b = await get_billing(current_user.uid)
        tier = BILLING_TIERS.get(b.membership_tier, BILLING_TIERS["free"])
        resp.minutes_left = {
            "day": tier["minutes_day"] - b.minutes_day,
            "week": tier["minutes_week"] - b.minutes_week,
            "month": tier["minutes_month"] - b.minutes_month,
        }
        resp.quantum_left = b.quantum_gift + b.quantum_perm
        minutes_ok = (est_minutes <= resp.minutes_left["day"]
                      and est_minutes <= resp.minutes_left["week"]
                      and est_minutes <= resp.minutes_left["month"])
        resp.quantum_enough = minutes_ok and est_quantum <= resp.quantum_left
        resp.can_afford = minutes_ok and est_quantum <= resp.quantum_left
    else:
        # 匿名：只走当日 10 分钟体验额度（消耗提示在前端做）
        resp.can_afford = None

    return resp


@app.post("/api/submit", response_model=TaskResponse)
async def submit_task(
    request: SubmitRequest,
    background_tasks: BackgroundTasks,
    req: Request,
    current_user: User | None = Depends(get_current_user_optional),
):
    """
    提交新的字幕提取任务
    支持 B站链接 或 文件上传；登录用户记录任务归属（统计/计费用）
    """
    # 磁盘空间检查
    if not check_disk_space():
        raise HTTPException(status_code=503, detail="磁盘空间不足，请稍后重试")

    # 计费：分钟余量检查（不扣费，成功后结算）
    import math
    est_minutes = request.est_minutes or 0
    if current_user:
        try:
            await check_minutes(current_user.uid, math.ceil(est_minutes * 1.2))
        except InsufficientError as e:
            raise HTTPException(status_code=403, detail=e.detail)
    else:
        # 匿名：按 IP 走每日体验额度（预估即预占，防刷）
        try:
            await check_and_consume_anon(
                req.client.host if req.client else "unknown", max(1, est_minutes),
            )
        except InsufficientError as e:
            raise HTTPException(status_code=403, detail=e.detail)

    task_id = generate_task_id()

    # 初始化任务状态
    tasks[task_id] = {
        "task_id": task_id,
        "status": TaskStatus.PENDING,
        "progress": 0,
        "source": request.source.value,
        "url": request.url,
        "sessdata": request.sessdata,
        "source_platform": platform_label(request.url),
        "owner_uid": current_user.uid if current_user else None,
        "est_minutes": est_minutes,
        "skip_segment": request.skip_segment,
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
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    sessdata: str | None = None,
    current_user: User | None = Depends(get_current_user_optional),
):
    """上传视频文件提取字幕；登录用户记录任务归属（统计用）"""
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
        "source_platform": platform_label(None),
        "owner_uid": current_user.uid if current_user else None,
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
    await delete_chat_messages(task_id)
    await delete_task_record(task_id)
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
    current_user: User | None = Depends(get_current_user_optional),
):
    """
    触发 Markdown 导出（增值功能，用户主动调用，消耗引力波）
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

    # 计费：未登录拦截 + 发起前余量检查（成功后在后台任务里结算）
    if not current_user:
        raise HTTPException(status_code=401, detail="登录后解锁 Markdown 笔记功能")
    try:
        await check_gravity(current_user.uid, len(task["raw_text"]) * 2)
    except InsufficientError as e:
        raise HTTPException(status_code=409, detail=e.detail)

    # 触发后台生成
    task["md_status"] = "generating"
    task["md_error"] = None
    background_tasks.add_task(_generate_md_background, task_id)

    return TaskResponse(**task)


@app.post("/api/summarize/{task_id}", response_model=TaskResponse)
async def summarize_task(
    task_id: str,
    background_tasks: BackgroundTasks,
    current_user: User | None = Depends(get_current_user_optional),
):
    """
    触发内容总结概要（增值功能，用户主动调用，消耗量子波）
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

    # 计费：未登录拦截 + 发起前余量检查（成功后在后台任务里结算）
    if not current_user:
        raise HTTPException(status_code=401, detail="登录后解锁内容总结功能")
    try:
        await check_quantum(current_user.uid, len(task["raw_text"]))
    except InsufficientError as e:
        raise HTTPException(status_code=409, detail=e.detail)

    # 触发后台生成
    task["summary_status"] = "generating"
    task["summary_error"] = None
    background_tasks.add_task(_generate_summary_background, task_id)

    return TaskResponse(**task)


@app.post("/api/chat/{task_id}")
async def chat_about_video(
    task_id: str,
    request: ChatRequest,
    current_user: User | None = Depends(get_current_user_optional),
):
    """
    AI 解读对话（SSE 流式，增值功能，消耗引力波）
    字幕全文放 system 且逐字一致，后续轮次自动命中 DeepSeek 前缀缓存（输入价 1/8）。
    事件协议：data: {"type":"delta","text":...} / {"type":"done","usage":...} / {"type":"error","message":...}
    """
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.get("status") != TaskStatus.COMPLETED:
        raise HTTPException(status_code=409, detail="任务尚未完成，无法对话")
    if task.get("cleaned"):
        raise HTTPException(status_code=410, detail="数据已清理，对话不可用")
    if not task.get("raw_text"):
        raise HTTPException(status_code=500, detail="字幕文本缺失，无法对话")

    # 计费：未登录拦截 + 发起前余量检查（done 后按实际 usage 结算）
    if not current_user:
        raise HTTPException(status_code=401, detail="登录后解锁 AI 解读功能")
    try:
        await check_gravity(current_user.uid, len(task["raw_text"]))
    except InsufficientError as e:
        raise HTTPException(status_code=409, detail=e.detail)

    # history 兜底截断：最近 8 条（前端已截，双保险；单条长度由 schema 限 2000）
    history = [{"role": m.role, "content": m.content} for m in request.history[-8:]]
    # 本轮提问追加为最后一条 user 消息
    history.append({"role": "user", "content": request.message})

    raw_text = task["raw_text"]
    video_title = task.get("video_title") or "未知视频"

    async def sse_generator():
        """同步 LLM 流丢线程池，经队列桥接为 async 迭代（不阻塞事件循环）"""
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        def worker():
            pieces = []
            try:
                for kind, payload in chat_with_subtitle_stream(
                    raw_text, video_title, history, task_id,
                ):
                    if kind == "delta":
                        pieces.append(payload)
                        loop.call_soon_threadsafe(queue.put_nowait, (kind, payload))
                    else:  # done：附带完整回复，供落库
                        loop.call_soon_threadsafe(
                            queue.put_nowait, (kind, (payload, "".join(pieces)))
                        )
            except Exception as e:
                loop.call_soon_threadsafe(queue.put_nowait, ("error", str(e)))
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer = asyncio.create_task(asyncio.to_thread(worker))
        full_reply = None
        final_usage = None
        charged = 0
        while True:
            item = await queue.get()
            if item is None:
                break
            kind, payload = item
            if kind == "delta":
                body = {"type": "delta", "text": payload}
            elif kind == "done":
                final_usage, full_reply = payload
                # 成功即结算（done 事件发出前完成扣费，事件里带实际扣额）
                if full_reply:
                    await save_chat_message(task_id, "user", request.message)
                    await save_chat_message(task_id, "assistant", full_reply, final_usage)
                    if current_user and final_usage:
                        charged = await consume_gravity(
                            current_user.uid,
                            final_usage["prompt_tokens"] + final_usage["completion_tokens"],
                            "chat", task_id,
                        )
                    owner_uid = (tasks.get(task_id) or {}).get("owner_uid")
                    if owner_uid and final_usage:
                        await incr_stats(
                            owner_uid,
                            chat_rounds=1,
                            tokens_used=final_usage["prompt_tokens"] + final_usage["completion_tokens"],
                        )
                body = {"type": "done", "usage": final_usage, "charged": charged}
            else:
                body = {"type": "error", "message": payload}
            yield f"data: {json.dumps(body, ensure_ascii=False)}\n\n"
        await producer

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/chat/{task_id}")
async def get_chat(task_id: str):
    """取回某任务的 AI 解读对话记录（面板打开/刷新时恢复）"""
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"messages": await get_chat_history(task_id)}


@app.get("/api/user/stats")
async def get_user_stats(current_user: User = Depends(get_current_user)):
    """当前用户的累计统计（设置页数据统计卡）"""
    return await get_stats(current_user.uid)


@app.get("/api/history")
async def get_history(current_user: User = Depends(get_current_user)):
    """当前用户的提取历史（按时间倒序，随任务清理联动删除）"""
    return {"records": await list_task_records(current_user.uid)}


@app.get("/api/diagnostics/export")
async def export_diagnostics(current_user: User = Depends(get_current_user)):
    """导出诊断包（脱敏 JSON：环境/系统/本人数据/任务快照/日志），用于问题排查"""
    from fastapi.responses import JSONResponse
    data = await build_diagnostics(current_user.uid, app.version, tasks)
    return JSONResponse(
        content=data,
        headers={
            "Content-Disposition": (
                f'attachment; filename="stellaris-diagnostics-'
                f'{time.strftime("%Y%m%d-%H%M%S")}.json"'
            ),
        },
    )


@app.get("/api/billing/summary")
async def billing_summary(current_user: User = Depends(get_current_user)):
    """三胶囊数据：分钟日/周/月已用+限额、量子波（赠送/活动）、引力波"""
    b = await get_billing(current_user.uid)
    tier = BILLING_TIERS.get(b.membership_tier, BILLING_TIERS["free"])
    return {
        "tier": b.membership_tier,
        "minutes": {
            "day": {"used": b.minutes_day, "limit": tier["minutes_day"]},
            "week": {"used": b.minutes_week, "limit": tier["minutes_week"]},
            "month": {"used": b.minutes_month, "limit": tier["minutes_month"]},
        },
        "quantum_gift": b.quantum_gift,
        "quantum_perm": b.quantum_perm,
        "gravity": b.gravity,
        "exchange_month_used": b.exchange_month_count,
        "exchange_month_cap": 5,
    }


@app.post("/api/billing/exchange")
async def billing_exchange_route(
    req: Request,
    current_user: User = Depends(get_current_user),
):
    """双向兑换：direction=q2g（25:1 月限 5）| g2q（1:20 不限次）"""
    body = await req.json()
    direction = body.get("direction", "")
    count = int(body.get("count", 0) or 0)
    try:
        result = await billing_exchange(direction, count, current_user.uid)
    except InsufficientError as e:
        raise HTTPException(status_code=409, detail=e.detail)
    return result


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
        result = download_bilibili(url, task_id, sessdata)
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

        # ⑤ LLM 语义分段（默认自动执行；量子波不足时用户可选降级跳过）
        task = tasks.get(task_id) or {}
        skip_segment = task.get("skip_segment", False)
        _update_status(task_id, TaskStatus.TEXT_PROCESSING, 70)
        if skip_segment:
            segmented_text = raw_text
            seg_usage = {"prompt_tokens": 0, "completion_tokens": 0}
            logger.info("[Pipeline] 用户选择跳过语义分段（量子波降级）: %s", task_id)
        else:
            segmented_text, seg_usage = segment_text(raw_text, task_id)

        # ⑥ 导出（TXT 用分段后的，SRT 用原始 segments 保留时间轴）
        _update_status(task_id, TaskStatus.EXPORTING, 90)
        srt_content = segments_to_srt(segments)
        export_paths = save_exports(task_id, srt_content, segmented_text)

        # ⑦ 统计埋点（登录用户才计数，未登录跳过）
        _incr_stats_sync(
            task.get("owner_uid"),
            videos_extracted=1,
            chars_transcribed=len(raw_text),
            tokens_used=seg_usage["prompt_tokens"] + seg_usage["completion_tokens"],
        )

        # ⑧ 计费结算（成功后；分钟按预估时长，分段按实际 usage）
        if task.get("owner_uid"):
            seg_tokens = seg_usage["prompt_tokens"] + seg_usage["completion_tokens"]
            _settle_billing_sync(task["owner_uid"], task.get("est_minutes") or 0,
                                 seg_tokens, task_id)
            # 历史记录（未登录不记）
            try:
                asyncio.run(save_task_record(
                    task_id, task["owner_uid"], video_title,
                    task.get("source_platform") or "",
                ))
            except Exception as he:
                logger.warning("[History] 记录失败(不影响主流程): %s", he)

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

        # ④ LLM 语义分段（支持降级跳过）
        task = tasks.get(task_id) or {}
        skip_segment = task.get("skip_segment", False)
        _update_status(task_id, TaskStatus.TEXT_PROCESSING, 70)
        if skip_segment:
            segmented_text = raw_text
            seg_usage = {"prompt_tokens": 0, "completion_tokens": 0}
        else:
            segmented_text, seg_usage = segment_text(raw_text, task_id)

        # ⑤ 导出
        _update_status(task_id, TaskStatus.EXPORTING, 90)
        srt_content = segments_to_srt(segments)
        save_exports(task_id, srt_content, segmented_text)

        # ⑥ 统计埋点（登录用户才计数，未登录跳过）
        _incr_stats_sync(
            task.get("owner_uid"),
            videos_extracted=1,
            chars_transcribed=len(raw_text),
            tokens_used=seg_usage["prompt_tokens"] + seg_usage["completion_tokens"],
        )

        # ⑦ 计费结算（成功后）
        if task.get("owner_uid"):
            seg_tokens = seg_usage["prompt_tokens"] + seg_usage["completion_tokens"]
            _settle_billing_sync(task["owner_uid"], task.get("est_minutes") or 0,
                                 seg_tokens, task_id)
            # 历史记录（未登录不记）
            try:
                asyncio.run(save_task_record(
                    task_id, task["owner_uid"], video_title,
                    task.get("source_platform") or "",
                ))
            except Exception as he:
                logger.warning("[History] 记录失败(不影响主流程): %s", he)

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

def _incr_stats_sync(owner_uid: int | None, **fields: int) -> None:
    """同步上下文（线程池）里累加用户统计；未登录（None）直接跳过"""
    if not owner_uid or not fields:
        return
    try:
        asyncio.run(incr_stats(owner_uid, **fields))
    except Exception as e:
        logger.warning("[Stats] 统计累加失败(不影响主流程): %s", e)


def _settle_billing_sync(owner_uid: int | None, minutes: int,
                         seg_tokens: int, task_id: str) -> None:
    """同步上下文（线程池）里做计费结算；未登录跳过，失败不影响主流程。
    结算结果（实际扣费）写回 task，供前端回显。"""
    if not owner_uid:
        return
    async def _run():
        charged_min = 0
        charged_q = 0
        if minutes > 0:
            await consume_minutes(owner_uid, minutes, task_id)
            charged_min = minutes
        if seg_tokens > 0:
            charged_q = await consume_quantum(owner_uid, seg_tokens, "segment", task_id)
        task = tasks.get(task_id)
        if task is not None:
            task["charged_minutes"] = charged_min
            task["charged_quantum"] = charged_q
    try:
        asyncio.run(_run())
    except Exception as e:
        logger.warning("[Billing] 结算失败(不影响主流程): %s", e)


def _generate_summary_background(task_id: str):
    """后台生成内容总结：调用 LLM 将字幕浓缩为结构化概要。"""
    task = tasks.get(task_id)
    if not task:
        return

    raw_text = task.get("raw_text", "")
    try:
        summary_content, summary_usage = summarize_text(raw_text, task_id)

        # 保存到任务目录（方便后续可能的下载需求）
        from utils import get_task_dir
        task_dir = get_task_dir(task_id)
        summary_path = task_dir / "output_summary.md"
        summary_path.write_text(summary_content, encoding="utf-8")

        task["summary_status"] = "ready"
        task["summary_error"] = None
        task["summary_content"] = summary_content   # 直接带回前端展示
        # 计费结算（生成成功后才扣量子波）
        if task.get("owner_uid"):
            total_tokens = summary_usage["prompt_tokens"] + summary_usage["completion_tokens"]
            try:
                task["summary_cost"] = asyncio.run(
                    consume_quantum(task["owner_uid"], total_tokens, "summary", task_id)
                )
            except Exception as be:
                logger.warning("[Billing] 概要结算失败(不影响功能): %s", be)
        _incr_stats_sync(
            task.get("owner_uid"),
            tokens_used=summary_usage["prompt_tokens"] + summary_usage["completion_tokens"],
        )
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
        md_content, md_usage = text_to_markdown(raw_text, task_id)

        # 保存到任务目录
        from utils import get_task_dir
        task_dir = get_task_dir(task_id)
        md_path = task_dir / "output.md"
        md_path.write_text(md_content, encoding="utf-8")

        task["md_status"] = "ready"
        task["md_error"] = None
        # 计费结算（生成成功后才扣引力波）
        if task.get("owner_uid"):
            total_tokens = md_usage["prompt_tokens"] + md_usage["completion_tokens"]
            try:
                task["md_cost"] = asyncio.run(
                    consume_gravity(task["owner_uid"], total_tokens, "md", task_id)
                )
            except Exception as be:
                logger.warning("[Billing] MD 结算失败(不影响功能): %s", be)
        _incr_stats_sync(
            task.get("owner_uid"),
            md_notes=1,
            tokens_used=md_usage["prompt_tokens"] + md_usage["completion_tokens"],
        )
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


# ===== 生产环境:serve 前端构建产物（同域;本地 frontend/dist 不存在则跳过,走 vite proxy）=====
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.exists():
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
