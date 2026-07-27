"""
Stellaris 后端入口 — FastAPI 应用
路由：健康检查 / 提交任务 / 查询状态 / 下载结果
"""
import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import (FastAPI, UploadFile, File, HTTPException, BackgroundTasks,
                     Depends, Request, Query, Header)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import (
    MAX_CONCURRENT_TASKS,
    SPEECH_CHARS_PER_MIN, CHARS_PER_TOKEN, LLM_TOKEN_ROUNDTRIP_FACTOR,
    TMP_DIR,
)
from utils import generate_task_id, cleanup_temp_files, check_disk_space, platform_label
from models import (
    SubmitRequest, TaskResponse, TaskStatus,
    HealthResponse, TaskSource,
    EstimateRequest, EstimateResponse,
    ChatRequest,
    CreateTicketRequest, AdminTicketReplyRequest,
)
from pipeline.download import download_bilibili, extract_audio_from_file, probe_bilibili_info
from pipeline.subtitle import fetch_cc_subtitle
from pipeline.asr import transcribe_with_mimo, probe_media_duration
from pipeline.llm import segment_text, text_to_markdown, summarize_text, chat_with_subtitle_stream
from chat_store import save_chat_message, get_chat_history, delete_chat_messages
from history_store import (
    save_task_record, list_task_records, delete_task_record,
    save_task_content, get_task_content, nullify_task_content,
    migrate_files_to_db,
    get_task_owner_map, get_task_record,
)
from diagnostics import attach_log_buffer, build_diagnostics
from pipeline.export import (
    segments_to_srt, segments_to_txt,
    bilibili_subtitle_to_segments, save_exports,
)

from database import init_db, get_db
from auth.router import router as auth_router
from auth.dependencies import get_current_user, get_current_user_optional, get_admin_user
from auth.models import User
from auth.utils import decode_access_token, get_client_ip   # get_client_ip: P1-12 X-Forwarded-For 拿真实 IP
from stats_store import incr_stats, get_stats
from billing_store import (
    BILLING_TIERS, TIER_DISPLAY, QUANTUM_PER_TOKEN_UNIT, round_tokens,
    get_billing, consume_minutes, consume_quantum, consume_gravity,
    check_minutes, check_quantum, check_gravity,
    check_and_consume_anon, refund_anon_minutes, exchange as billing_exchange,
    InsufficientError, SEG_TOKENS_PER_MIN,
    retention_hours_map, get_ledger, grant_membership,
)
from admin_store import (
    AdminError, PinError, get_overview, get_user_usage, get_trends, search_users,
    adjust_balance, revoke_membership, list_codes, list_orders, fulfill_order,
    recheck_order, set_pin, pin_status, verify_admin_pin,
    get_codes_summary, get_feature_usage, get_recent_tasks, get_health,
    get_anon_usage_today,
)


# ===== 内存中的任务存储（生产环境应换 Redis）=====
tasks: dict[str, dict] = {}
running_tasks: set = set()  # 正在运行的任务 ID 集合
_upload_rejected_count: int = 0  # 安全面板：超大文件驳回计数
_upload_rejected_events: list = []  # 安全面板：超大文件驳回事件（环形缓冲，最多 50）
# R2 串行信号量：兑现 MAX_CONCURRENT_TASKS 的承诺，管线 / MD / 概要后台任务排队执行，
# 既防 4GB 内存被打爆，也消除扣费 TOCTOU。chat SSE 流不包（轻量即时，扣费已原子化）。
_pipeline_sem = asyncio.Semaphore(MAX_CONCURRENT_TASKS)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动/关闭时的初始化/清理"""
    print("[Stellaris] starting up...")
    attach_log_buffer()   # 内存环形日志缓冲（诊断导出用）
    # 初始化数据库（建表）——分档清理依赖 task_records/user_billing，须先建表
    await init_db()
    print("[Stellaris] 数据库已就绪")
    # V0.12.2: 一次性迁移 TMP_DIR 存量文件到 DB（幂等，在清理之前执行）
    migrated = await migrate_files_to_db()
    if migrated:
        print(f"[Stellaris] 内容迁移：{migrated} 个任务从文件写入数据库")
    # 启动时清理上次进程留下的过期任务文件（联动删对话记录，DB 内容列置 NULL 保留元数据）
    removed = await _cleanup_expired_tasks()
    if removed:
        print(f"[Stellaris] 启动清理：{len(removed)} 个过期任务")
        for tid in removed:
            await delete_chat_messages(tid)
            await nullify_task_content(tid)
    # 起后台定时清理任务（每 10 分钟扫一次）
    cleanup_task = asyncio.create_task(_periodic_cleanup())
    # 起后台定时备份任务（每天 04:00，UTC+8；COS 未配置则自动跳过）
    from backup_store import _periodic_backup
    backup_task = asyncio.create_task(_periodic_backup())
    yield
    # 关闭：只取消定时任务。任务文件【不】在关闭时删除——交给分档清理按各档位
    # 保留时长处理；否则每次重启/部署都会清空会员的长保留数据（碳碳实测踩坑：
    # admin 永久保留的任务在重启后目录消失）
    cleanup_task.cancel()
    backup_task.cancel()
    print("[Stellaris] shut down.")


async def _cleanup_expired_tasks() -> list[str]:
    """分档保留清理：按任务归属用户的有效档位 history_hours 判定过期。
    匿名/无记录任务按 1 小时；admin/Stella（None）永久保留。返回被清理的 task_id 列表。"""
    if not TMP_DIR.exists():
        return []
    now = time.time()
    dirs = []
    for task_dir in TMP_DIR.iterdir():
        if not task_dir.is_dir():
            continue
        try:
            dirs.append((task_dir.name, task_dir.stat().st_mtime))
        except OSError:
            continue
    if not dirs:
        return []
    owners = await get_task_owner_map([name for name, _ in dirs])
    uids = list({u for u in owners.values() if u})
    retention = await retention_hours_map(uids)
    removed = []
    for name, mtime in dirs:
        uid = owners.get(name)
        hours = retention.get(uid, 1) if uid else 1   # 匿名/无记录 = 1 小时
        if hours is None:
            continue                                   # 永久保留档
        if now - mtime > hours * 3600:
            cleanup_temp_files(name)
            removed.append(name)
    return removed


async def _periodic_cleanup():
    """后台定时清理：每 10 分钟扫描并清理过期任务文件（联动删对话/历史记录）。"""
    while True:
        await asyncio.sleep(600)
        try:
            removed = await _cleanup_expired_tasks()
            if removed:
                logger.info("[Cleanup] 定时清理：删除 %d 个过期任务", len(removed))
                for tid in removed:
                    await delete_chat_messages(tid)
                    await nullify_task_content(tid)
        except Exception as e:
            logger.error("[Cleanup] 定时清理失败: %s", e)


app = FastAPI(
    title="Stellaris",
    description="Turning voices into words you can read.",
    version="1.0.1-alcyone",
    lifespan=lifespan,
)

# gzip 压缩（V0.9.2：静态产物此前裸传 1MB+，跨境慢线下载 136s → 压缩后约 1/3）
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def static_cache_headers(request, call_next):
    """静态缓存头（V0.9.2）：vite 产物文件名带内容 hash，可永久缓存；
    index.html 不缓存（每次发版即时生效）"""
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# CORS（P0-5 安全：白名单收敛，不再 allow_origins=["*"]）
from config import ALLOWED_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# P2-15 安全头中间件：X-Content-Type-Options + Referrer-Policy
@app.middleware("http")
async def _security_headers_middleware(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# P1-9 全局异常处理器：未捕获异常统一脱敏，详情只写日志
@app.exception_handler(Exception)
async def _global_exception_handler(request, exc):
    logger.exception("未捕获异常: %s %s", request.method, request.url)
    return JSONResponse(status_code=500, content={"detail": "服务器内部错误"})


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
    from config import TURNSTILE_SITE_KEY, IS_PROD, AFDIAN_SHOP_URL, AFDIAN_PLAN_URLS
    try:
        plan_urls = json.loads(AFDIAN_PLAN_URLS or "{}")
    except json.JSONDecodeError:
        plan_urls = {}
    return {
        "turnstile_site_key": TURNSTILE_SITE_KEY,
        "is_prod": IS_PROD,
        "afdian_shop_url": AFDIAN_SHOP_URL,
        "afdian_plan_urls": plan_urls,
    }


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
        logger.warning("estimate 探测失败: %s", str(e)[:200])
        raise HTTPException(status_code=400, detail="无法解析链接信息，请检查链接是否正确")

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
        b, tier_key = await get_billing(current_user.uid)
        tier = BILLING_TIERS.get(tier_key, BILLING_TIERS["free"])
        if tier.get("unlimited"):
            resp.minutes_left = None
            resp.quantum_left = b.quantum_gift + b.quantum_perm
            resp.quantum_enough = True
            resp.can_afford = True
        else:
            # minutes_* 为 None 表示该周期不限（如 Stella 日/周），只卡有上限的周期
            resp.minutes_left = {
                p: (None if tier.get(f"minutes_{p}") is None
                    else tier[f"minutes_{p}"] - getattr(b, f"minutes_{p}"))
                for p in ("day", "week", "month")
            }
            resp.quantum_left = b.quantum_gift + b.quantum_perm
            minutes_ok = all(left is None or est_minutes <= left
                             for left in resp.minutes_left.values())
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
                get_client_ip(req), max(1, est_minutes),  # P1-12
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
        "owner_ip": get_client_ip(req),  # P1-12 R3：匿名失败退还预占额度用
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
    req: Request,
    file: UploadFile = File(...),
    sessdata: str | None = None,
    current_user: User | None = Depends(get_current_user_optional),
):
    """上传视频文件提取字幕；登录用户记录任务归属（统计/计费用）。
    计费与 /api/submit 三段对齐：路由层 ffprobe 探时长 + 预检/预占 → 成功结算 → 失败退还。"""
    if not check_disk_space():
        raise HTTPException(status_code=503, detail="磁盘空间不足")

    task_id = generate_task_id()

    # 保存上传的文件
    from utils import get_task_dir
    from config import MAX_VIDEO_SIZE_MB
    task_dir = get_task_dir(task_id)
    # P0-1 安全：filename 取 basename 防路径穿越（恶意客户端可构造 ../../etc/passwd）
    safe_name = Path(file.filename).name if file.filename else "upload"
    file_path = task_dir / f"upload_{safe_name}"

    content = await file.read()
    # P0-2 安全：校验文件大小，防耗尽内存/磁盘
    if len(content) > MAX_VIDEO_SIZE_MB * 1024 * 1024:
        global _upload_rejected_count
        _upload_rejected_count += 1
        import time as _ut
        _upload_rejected_events.append({
            "time": _ut.strftime("%m-%d %H:%M:%S"), "type": "upload_rejected",
            "detail": f"超大文件驳回：{safe_name} ({len(content) / 1024 / 1024:.0f}MB > {MAX_VIDEO_SIZE_MB}MB)",
        })
        if len(_upload_rejected_events) > 50: _upload_rejected_events.pop(0)
        cleanup_temp_files(task_id)
        raise HTTPException(status_code=413, detail=f"文件过大，上限 {MAX_VIDEO_SIZE_MB}MB")
    file_path.write_bytes(content)

    # 计费前置：ffprobe 探时长（裸文件路由层才能知时长；asyncio.to_thread 避免阻塞事件循环——踩坑 1）
    import math
    duration = await asyncio.to_thread(probe_media_duration, file_path)
    if duration <= 0:
        cleanup_temp_files(task_id)
        raise HTTPException(status_code=400, detail="无法识别媒体时长，请检查文件是否损坏或格式不受支持")
    est_minutes = max(1, math.ceil(duration / 60))
    ip = get_client_ip(req)  # P1-12

    # 预检/预占（与 submit 对齐：登录预检不扣、1.2 倍冗余；匿名预估即预占防刷）
    try:
        if current_user:
            await check_minutes(current_user.uid, math.ceil(est_minutes * 1.2))
        else:
            await check_and_consume_anon(ip, est_minutes)
    except InsufficientError as e:
        cleanup_temp_files(task_id)   # 额度不足，清理已落盘文件防恶意堆积
        raise HTTPException(status_code=403, detail=e.detail)

    tasks[task_id] = {
        "task_id": task_id,
        "status": TaskStatus.PENDING,
        "progress": 0,
        "source": TaskSource.FILE_UPLOAD.value,
        "file_path": str(file_path),
        "sessdata": sessdata,
        "source_platform": platform_label(None),
        "owner_uid": current_user.uid if current_user else None,
        "owner_ip": ip,                # 匿名失败退还预占额度用（与 submit 一致）
        "est_minutes": est_minutes,    # 管线结算扣费用（此前缺失 → 登录用户分钟白送）
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


def _authorize_task(task: dict, current_user: User | None) -> None:
    """R1 任务级鉴权：匿名任务(owner_uid 为 None)放行；有主则仅本人可访问，
    他人一律 404（掩藏存在性，不返 403）。"""
    owner_uid = task.get("owner_uid")
    if owner_uid is None:
        return  # 匿名任务：无账号归属，放行（靠 1 小时自动清理兜底）
    if current_user is not None and current_user.uid == owner_uid:
        return
    raise HTTPException(status_code=404, detail="任务不存在")


async def _resolve_user_for_download(
    authorization: str | None, token: str | None, db: AsyncSession,
) -> User | None:
    """R1 下载专用：下载是 <a href> 裸跳转不带 Authorization header，
    故额外支持 ?token= 查询参数；header 优先，其次 query。"""
    raw = None
    if authorization and authorization.startswith("Bearer "):
        raw = authorization[7:]
    elif token:
        raw = token
    if not raw:
        return None
    payload = decode_access_token(raw)
    if not payload or payload.get("uid") is None:
        return None
    result = await db.execute(select(User).where(User.uid == payload["uid"]))
    return result.scalar_one_or_none()


@app.get("/api/task/{task_id}", response_model=TaskResponse)
async def get_task_status(
    task_id: str,
    current_user: User | None = Depends(get_current_user_optional),
):
    """查询任务状态和结果（内存缺失时冷启动重建，会员长保留依赖）"""
    task = tasks.get(task_id)
    if not task:
        task = await _rehydrate_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    _authorize_task(task, current_user)
    return TaskResponse(**task)


async def _rehydrate_task(task_id: str) -> dict | None:
    """冷启动重建：DB 优先，文件兜底（V0.12.3 起文件路径仅服务匿名任务与 V0.12.2 前存量残留）。
    DB 有内容 → 直接取；DB 无内容 → 读 TMP_DIR 文件（匿名任务/存量任务的兜底）。"""
    record = await get_task_record(task_id)
    content = await get_task_content(task_id)
    db_text = content.get("raw_text") if content else None
    has_db_content = bool(db_text)

    task_dir = TMP_DIR / task_id

    if has_db_content:
        text = db_text
        srt_available = bool(content.get("subtitle_srt"))
        md_ready = bool(content.get("md_content"))
        summary_ready = bool(content.get("summary_content"))
        summary_content = content.get("summary_content") or None
    else:
        # 文件兜底：存量任务或 DB 写失败
        txt_path = task_dir / "output.txt"
        if not txt_path.exists():
            return None
        try:
            text = txt_path.read_text(encoding="utf-8")
        except OSError:
            return None
        srt_available = (task_dir / "output.srt").exists()
        md_ready = (task_dir / "output.md").exists()
        summary_content = None
        summary_path = task_dir / "output_summary.md"
        if summary_path.exists():
            try:
                summary_content = summary_path.read_text(encoding="utf-8")
            except OSError:
                pass
        summary_ready = bool(summary_content)

    task = {
        "task_id": task_id,
        "status": TaskStatus.COMPLETED,
        "message": "完成！",
        "progress": 100,
        "video_title": (record or {}).get("title"),
        "source_platform": (record or {}).get("source_platform"),
        "owner_uid": (record or {}).get("owner_uid"),
        "subtitle_srt": "available" if srt_available else None,
        "subtitle_txt": text,
        "raw_text": text,
        "subtitle_source": None,
        "md_status": "ready" if md_ready else "idle",
        "summary_status": "ready" if summary_ready else "idle",
        "summary_content": summary_content,
        "rehydrated": True,
    }
    tasks[task_id] = task
    return task


@app.delete("/api/task/{task_id}", response_model=TaskResponse)
async def delete_task(
    task_id: str,
    current_user: User | None = Depends(get_current_user_optional),
):
    """
    用户主动清理任务数据（删除临时文件，不可恢复）。
    任务状态保留在内存（前端刷新仍能看到 cleaned 标记）。
    """
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    _authorize_task(task, current_user)

    cleanup_temp_files(task_id)
    await delete_chat_messages(task_id)
    await delete_task_record(task_id)
    task["cleaned"] = True
    logger.info("[Cleanup] 用户主动清理: %s", task_id)

    return TaskResponse(**task)


# 下载文件版权尾注（仅响应层追加，DB 存储与页面预览保持纯净；SRT 时间轴格式豁免）
# © 后带 U+FE0E 文本样式选择符：强制按文字符号渲染，避免被系统画成 emoji
DOWNLOAD_FOOTER_TXT = (
    "\n\n———\n"
    "本字幕由 Stellaris 提取生成 · https://stellaris.ytunx.com/\n"
    "开源项目 · https://github.com/Yuntian-Liu/Stellaris\n"
    "Copyright ©︎ Yuntian-Liu. All Rights Reserved.\n"
)
DOWNLOAD_FOOTER_MD = (
    "\n\n---\n"
    "> 本笔记由 [Stellaris](https://stellaris.ytunx.com/) 生成 · "
    "[GitHub 开源](https://github.com/Yuntian-Liu/Stellaris)\n"
    "> Copyright ©︎ Yuntian-Liu. All Rights Reserved.\n"
)


@app.get("/api/download/{task_id}/{format}")
async def download_result(
    task_id: str,
    format: str,
    token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """下载生成的字幕文件（srt/txt/md）。
    R1：下载是 <a href> 裸跳转不带 JWT header，故兼容 ?token= 查询参数。"""
    if format not in ("srt", "txt", "md"):
        raise HTTPException(status_code=400, detail="格式仅支持 srt、txt 或 md")

    current_user = await _resolve_user_for_download(authorization, token, db)
    task = tasks.get(task_id)
    if not task:
        task = await _rehydrate_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="文件不存在（任务可能尚未完成或已清理）")
    _authorize_task(task, current_user)

    # V0.12.3: DB 优先；文件兜底仅服务匿名任务与存量残留
    col_map = {"txt": "raw_text", "srt": "subtitle_srt", "md": "md_content"}
    content = await get_task_content(task_id)
    text = content.get(col_map[format]) if content else None

    if not text:
        # 文件兜底（匿名任务 / V0.12.2 前存量任务）
        from utils import get_task_dir
        task_dir = get_task_dir(task_id)
        file_path = task_dir / f"output.{format}"
        if file_path.exists():
            try:
                text = file_path.read_text(encoding="utf-8")
            except OSError:
                pass

    if not text:
        raise HTTPException(status_code=404, detail="文件不存在（任务可能尚未完成或该格式未生成）")

    # 版权尾注：只在"出门"时追加，DB/预览保持纯净；SRT 时间轴格式豁免（V0.12.5 定稿）
    if format == "txt":
        text = text.rstrip() + DOWNLOAD_FOOTER_TXT
    elif format == "md":
        text = text.rstrip() + DOWNLOAD_FOOTER_MD

    media_type_map = {
        "txt": "text/plain",
        "srt": "application/x-subrip",
        "md": "text/markdown",
    }
    from fastapi.responses import Response as FastAPIResponse
    return FastAPIResponse(
        content=text,
        headers={"Content-Disposition": f'attachment; filename="stellaris-{task_id}.{format}"'},
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

    # 管理员调试模式：消息以 [debug] 开头时绕过字幕约束（仅 uid=100001）
    is_admin_debug = False
    message = request.message
    if current_user.is_admin and message.startswith("[debug]"):
        is_admin_debug = True
        message = message[len("[debug]"):].strip() or "你好"

    # history 兜底截断：最近 8 条（前端已截，双保险；单条长度由 schema 限 2000）
    history = [{"role": m.role, "content": m.content} for m in request.history[-8:]]
    # 本轮提问追加为最后一条 user 消息
    history.append({"role": "user", "content": message})

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
                    raw_text, video_title, history, task_id, is_admin_debug,
                ):
                    if kind == "delta":
                        pieces.append(payload)
                        loop.call_soon_threadsafe(queue.put_nowait, (kind, payload))
                    else:  # done：附带完整回复，供落库
                        loop.call_soon_threadsafe(
                            queue.put_nowait, (kind, (payload, "".join(pieces)))
                        )
            except Exception as e:
                # OpenAI SDK 异常 str(e) 可能是字典字符串，提取人类可读 message
                msg = getattr(e, "message", None) or str(e)
                if not isinstance(msg, str):
                    msg = json.dumps(msg, ensure_ascii=False)
                logger.exception("[Chat] AI 解读流式失败 (task=%s): %s", task_id, msg)
                loop.call_soon_threadsafe(queue.put_nowait, ("error", msg))
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer = asyncio.create_task(asyncio.to_thread(worker))
        full_reply = None
        final_usage = None
        charged = 0
        try:
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
        finally:
            # P1-7 SSE 断连白嫖兜底：LLM 已返回 usage 但 done 事件未处理（客户端断开），补扣
            if final_usage is not None and charged == 0 and current_user:
                try:
                    charged = await consume_gravity(
                        current_user.uid,
                        final_usage["prompt_tokens"] + final_usage["completion_tokens"],
                        "chat", task_id,
                    )
                    owner_uid = (tasks.get(task_id) or {}).get("owner_uid")
                    if owner_uid:
                        await incr_stats(
                            owner_uid, chat_rounds=1,
                            tokens_used=final_usage["prompt_tokens"] + final_usage["completion_tokens"],
                        )
                except Exception as be:
                    logger.warning("[Billing] SSE catch-up 结算失败: %s", be)
        await producer

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/chat/{task_id}")
async def get_chat(
    task_id: str,
    current_user: User | None = Depends(get_current_user_optional),
):
    """取回某任务的 AI 解读对话记录（面板打开/刷新时恢复）"""
    task = tasks.get(task_id)
    if not task:
        task = await _rehydrate_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    _authorize_task(task, current_user)
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
    """三胶囊数据：分钟日/周/月已用+限额、量子波（赠送/活动）、引力波 + 档位信息"""
    b, tier_key = await get_billing(current_user.uid)
    tier = BILLING_TIERS.get(tier_key, BILLING_TIERS["free"])
    unlimited = bool(tier.get("unlimited"))
    name, cn = TIER_DISPLAY.get(tier_key, TIER_DISPLAY["free"])
    expire = b.membership_expire_at
    expire_iso = expire.isoformat() + ("Z" if expire and not expire.tzinfo else "") if expire else None
    return {
        "tier": tier_key,
        "tier_name": name,
        "tier_cn": cn,
        "unlimited": unlimited,
        # 付费档到期时间（9999 = 永久档不下发）；free/admin 为 None；补 Z 按 UTC 序列化
        "expire_at": (expire_iso if expire and expire.year < 9999 else None),
        "minutes": {
            p: {"used": getattr(b, f"minutes_{p}"),
                "limit": None if unlimited else tier.get(f"minutes_{p}")}
            for p in ("day", "week", "month")
        },
        "quantum_gift": b.quantum_gift,
        "quantum_perm": b.quantum_perm,
        "gravity": b.gravity,
        "exchange_month_used": b.exchange_month_count,
        "exchange_month_cap": (None if tier.get("exchange_unlimited")
                               else tier.get("exchange_cap", 5)),
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


@app.get("/api/billing/ledger")
async def billing_ledger_route(
    page: int = 1,
    size: int = 20,
    currency: str | None = None,
    current_user: User = Depends(get_current_user),
):
    """消耗记录（分页，时间倒序）：分钟/量子波（含双钱包拆分）/引力波流水，可按货币筛选"""
    page = max(1, page)
    size = min(max(1, size), 50)
    if currency not in (None, "minute", "quantum", "gravity"):
        currency = None
    return await get_ledger(current_user.uid, page, size, currency)


@app.post("/api/afdian/webhook")
async def afdian_webhook(req: Request):
    """爱发电订单回调（路径 A 主路）：RSA 验签 → 幂等 → 按方案映射开通会员。
    必须返回 {"ec":200} 确认，否则平台视为失败重试；无法处理的订单落库标记人工处理。"""
    from afdian_store import verify_webhook_sign, order_exists, record_order
    from config import AFDIAN_PLAN_MAP
    try:
        body = await req.json()
    except Exception:
        return {"ec": 400, "em": "bad json"}
    data = body.get("data") or {}
    if body.get("ec") != 200 or data.get("type") != "order":
        return {"ec": 200, "em": ""}          # 非订单推送（如联通测试）直接确认
    order = data.get("order") or {}
    out_trade_no = order.get("out_trade_no", "")
    plan_id = order.get("plan_id", "")
    total_amount = order.get("total_amount", "")
    payload = json.dumps(body, ensure_ascii=False)

    # ① RSA 验签（防伪造推送）
    if not verify_webhook_sign(order, data.get("sign", "")):
        if out_trade_no and not await order_exists(out_trade_no):
            await record_order(out_trade_no, None, plan_id, total_amount, "bad_sign", payload)
        logger.warning("[Afdian] 验签失败，拒绝发货: %s", out_trade_no)
        return {"ec": 401, "em": "invalid sign"}

    # ② 幂等（平台可能重复推送）
    if await order_exists(out_trade_no):
        return {"ec": 200, "em": ""}

    # ③ 仅处理支付成功（status=2，目前平台也只推这类）
    if order.get("status") != 2:
        await record_order(out_trade_no, None, plan_id, total_amount, "ignored", payload)
        return {"ec": 200, "em": ""}

    # ③.5 自选金额（plan_id 为空）= 赞赏：只落库致谢，不涉及会员开通
    # （顺带承担"生产支付链路冒烟测试"职责：一笔赞赏即可验证 推送→验签→落库 全链路）
    if not plan_id:
        uid = None
        m = re.search(r"\d+", str(order.get("custom_order_id") or ""))
        if m:
            uid = int(m.group())
        await record_order(out_trade_no, uid, "", total_amount, "donation", payload)
        logger.info("[Afdian] 收到赞赏: ¥%s (uid=%s, order=%s)", total_amount, uid, out_trade_no)
        return {"ec": 200, "em": ""}

    # ④ 用户映射（custom_order_id = Stellaris UID，付款链接 URL 传参携带）
    uid = None
    custom = str(order.get("custom_order_id") or "")
    m = re.search(r"\d+", custom)
    if m:
        uid = int(m.group())
    if not uid:
        await record_order(out_trade_no, None, plan_id, total_amount, "unmapped_user", payload)
        logger.warning("[Afdian] 无法关联用户(custom_order_id=%r): %s", custom, out_trade_no)
        return {"ec": 200, "em": ""}

    # ⑤ 方案映射（plan_id → 档位 + 天数；试用档在映射里配 days=7）
    try:
        plan_map = json.loads(AFDIAN_PLAN_MAP or "{}")
    except json.JSONDecodeError:
        plan_map = {}
    plan = plan_map.get(plan_id)
    if not plan:
        await record_order(out_trade_no, uid, plan_id, total_amount, "unknown_plan", payload)
        logger.warning("[Afdian] 方案未配置(plan_id=%s): %s", plan_id, out_trade_no)
        return {"ec": 200, "em": ""}

    # ⑥ 开通（month 为购买月数，天数按倍数顺延；同档续费在 grant_membership 内累加）
    # Y1：先 INSERT OR IGNORE 原子占位抢锁——rowcount=0 即并发败者或重复推送，直接确认；
    # 占位成功再 grant，grant 异常置 grant_failed（订单已落库可追，不丢单、不 500）。
    from afdian_store import update_order_status
    months = max(1, int(order.get("month") or 1))
    days = int(plan["days"]) * months
    if await record_order(out_trade_no, uid, plan_id, total_amount, "granting", payload) == 0:
        return {"ec": 200, "em": ""}   # 并发败者/重复推送，已由先到者处理
    try:
        await grant_membership(uid, plan["tier"], days)
        await update_order_status(out_trade_no, "processed")
        logger.info("[Afdian] 会员开通: uid=%s tier=%s days=%s order=%s",
                    uid, plan["tier"], days, out_trade_no)
    except Exception as ge:
        await update_order_status(out_trade_no, "grant_failed")
        logger.error("[Afdian] 开通失败(订单已占位,待人工): %s - %s", out_trade_no, ge)
    return {"ec": 200, "em": ""}


@app.get("/api/redeem/preview")
async def redeem_preview(code: str, current_user: User = Depends(get_current_user)):
    """兑换前预览（不核销）：返回档位+天数，无效码 404"""
    from redeem_store import preview_code, RedeemError
    try:
        return await preview_code(code)
    except RedeemError as e:
        raise HTTPException(status_code=404, detail=e.detail)


@app.get("/api/membership/history")
async def membership_history(current_user: User = Depends(get_current_user)):
    """会员开通记录：爱发电订单 + 兑换码兑换，合并按时间倒序"""
    from afdian_store import get_orders_for_user
    from redeem_store import get_redemptions_for_user
    from config import AFDIAN_PLAN_MAP
    try:
        plan_map = json.loads(AFDIAN_PLAN_MAP or "{}")
    except json.JSONDecodeError:
        plan_map = {}
    items = []
    for o in await get_orders_for_user(current_user.uid):
        plan = plan_map.get(o["plan_id"], {})
        items.append({
            "source": "爱发电",
            "tier": plan.get("tier"),
            "days": plan.get("days"),
            "amount": o["total_amount"],
            "time": o["created_at"],
        })
    for r in await get_redemptions_for_user(current_user.uid):
        items.append({
            "source": "兑换码" if not r["note"] else r["note"],
            "tier": r["tier"],
            "days": r["days"],
            "amount": None,
            "time": r["used_at"],
        })
    items.sort(key=lambda x: x["time"] or "", reverse=True)
    return {"items": items}


@app.post("/api/redeem")
async def redeem_route(req: Request, current_user: User = Depends(get_current_user)):
    """核销兑换码（二次确认后调用）：开通会员，已用/过期 409"""
    from redeem_store import redeem_code, RedeemError
    body = await req.json()
    code = str(body.get("code", "")).strip()
    if not code:
        raise HTTPException(status_code=400, detail="请输入兑换码")
    try:
        result = await redeem_code(code, current_user.uid)
    except RedeemError as e:
        raise HTTPException(status_code=409, detail=e.detail)
    return result


# ===== 管理看板（V0.9.0，全部 get_admin_user 守卫：非 admin 403）=====

async def _check_admin_pin(current_user: User, body: dict) -> None:
    """敏感操作 PIN 二次验证：未设 409 / 错误 403 / 锁定 423"""
    try:
        await verify_admin_pin(current_user.uid, str(body.get("pin", "") or "").strip())
    except PinError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@app.post("/api/admin/pin/set")
async def admin_set_pin(
    req: Request,
    current_user: User = Depends(get_admin_user),
):
    """设置/更新管理 PIN {pin}：6 位纯数字，bcrypt 哈希落库"""
    body = await req.json()
    try:
        await set_pin(current_user.uid, str(body.get("pin", "") or "").strip())
    except AdminError as e:
        raise HTTPException(status_code=400, detail=e.detail)
    return {"pin_set": True}


@app.get("/api/admin/pin/status")
async def admin_pin_status(current_user: User = Depends(get_admin_user)):
    """PIN 是否已设置（前端决定弹「设置」还是「验证」）"""
    return {"pin_set": await pin_status(current_user.uid)}


@app.post("/api/admin/backup")
async def admin_backup_now(req: Request, current_user: User = Depends(get_admin_user)):
    """手动触发一次数据库备份。敏感操作：body 须带 pin（PIN 二次验证）。"""
    body = await req.json()
    await _check_admin_pin(current_user, body)
    from backup_store import do_backup, _cos_enabled
    result = await do_backup(manual=True)
    return {"enabled": _cos_enabled(), **result}


@app.get("/api/admin/backup-status")
async def admin_backup_status(current_user: User = Depends(get_admin_user)):
    """备份状态：COS 配置、上次备份结果、保留策略、DB 大小"""
    from backup_store import get_backup_status
    status = get_backup_status()
    health = await get_health()
    return {**status, "db_size_mb": health["db_size_mb"]}


@app.get("/api/admin/security-status")
async def admin_security_status(current_user: User = Depends(get_admin_user)):
    """安全面板：认证/网络/密钥/待修复缺口一览（纯配置读取，零数据库负载）"""
    from security_store import get_security_status
    return get_security_status()


@app.get("/api/admin/trends")
async def admin_trends(
    days: int = 30,
    current_user: User = Depends(get_admin_user),
):
    """趋势图表数据：近 N 天每日消耗/收入/新增注册（UTC+8 04:00 界，缺天补零）"""
    return await get_trends(days)


@app.get("/api/admin/overview")
async def admin_overview(current_user: User = Depends(get_admin_user)):
    """看板统计卡数据（口径见 admin_store.get_overview docstring）"""
    # 内存中未完成任务无 task_records 记录，补入计数（已完成的有记录，不重复计）
    active = sum(1 for t in tasks.values() if t.get("status") != TaskStatus.COMPLETED)
    return await get_overview(active)


@app.get("/api/admin/users")
async def admin_search_users(
    query: str = "",
    current_user: User = Depends(get_admin_user),
):
    """用户搜索：email 模糊 或 uid 精确，返回计费摘要（limit 20）"""
    return {"items": await search_users(query)}


@app.post("/api/admin/user/adjust")
async def admin_adjust_balance(
    req: Request,
    current_user: User = Depends(get_admin_user),
):
    """调余额 {uid, quantum_delta?, gravity_delta?}：±调整（下限 0），流水记 admin_adjust。
    敏感操作：body 须带 pin（PIN 二次验证）"""
    body = await req.json()
    await _check_admin_pin(current_user, body)
    uid = int(body.get("uid", 0) or 0)
    quantum_delta = int(body.get("quantum_delta", 0) or 0)
    gravity_delta = int(body.get("gravity_delta", 0) or 0)
    note = str(body.get("note", "") or "")[:64]
    if not uid:
        raise HTTPException(status_code=400, detail="缺少 uid")
    if not quantum_delta and not gravity_delta:
        raise HTTPException(status_code=400, detail="调整量不能全为 0")
    try:
        return await adjust_balance(uid, quantum_delta, gravity_delta, note=note)
    except AdminError as e:
        raise HTTPException(status_code=404, detail=e.detail)


@app.get("/api/admin/user/{uid}/usage")
async def admin_user_usage(
    uid: int,
    current_user: User = Depends(get_admin_user),
):
    """单用户用量详情：今日/累计三货币消耗 + 功能使用次数 + 最近 20 条流水 + 累计统计"""
    try:
        return await get_user_usage(uid)
    except AdminError as e:
        raise HTTPException(status_code=404, detail=e.detail)


@app.post("/api/admin/user/tier")
async def admin_set_tier(
    req: Request,
    current_user: User = Depends(get_admin_user),
):
    """调档位 {uid, tier, days?}：tier="free" = 收回；其余复用 grant_membership
    （days=None 为 Stella 永久档，非 stella 必须传正整数天数）。
    敏感操作：body 须带 pin（PIN 二次验证）"""
    body = await req.json()
    await _check_admin_pin(current_user, body)
    uid = int(body.get("uid", 0) or 0)
    tier = str(body.get("tier", "")).strip()
    days = body.get("days")
    days = int(days) if days not in (None, "") else None
    if not uid or not tier:
        raise HTTPException(status_code=400, detail="缺少 uid 或 tier")
    if tier == "free":
        try:
            return await revoke_membership(uid)
        except AdminError as e:
            raise HTTPException(status_code=404, detail=e.detail)
    if tier not in ("trial", "stargazer", "voyager", "odyssey", "stella"):
        raise HTTPException(status_code=400, detail=f"非法的会员档位：{tier}")
    if tier != "stella" and (days is None or days <= 0):
        raise HTTPException(status_code=400, detail="非 Stella 档必须传正整数天数")
    try:
        return await grant_membership(uid, tier, days)
    except InsufficientError as e:
        raise HTTPException(status_code=400, detail=e.detail)


@app.get("/api/admin/codes")
async def admin_list_codes(current_user: User = Depends(get_admin_user)):
    """兑换码列表（时间倒序，含用量/使用者/过期/备注）"""
    return {"items": await list_codes()}


@app.post("/api/admin/codes")
async def admin_create_codes(
    req: Request,
    current_user: User = Depends(get_admin_user),
):
    """生成兑换码 {tier, days?, count, custom_code?, note?, expires_at?}
    Stella 邀请码 = tier stella + days 空 + custom_code 自定义内容。
    敏感操作：body 须带 pin（PIN 二次验证）"""
    from redeem_store import create_code
    body = await req.json()
    await _check_admin_pin(current_user, body)
    tier = str(body.get("tier", "")).strip()
    days = body.get("days")
    days = int(days) if days not in (None, "") else None
    count = int(body.get("count", 1) or 1)
    custom_code = (body.get("custom_code") or "").strip() or None
    note = str(body.get("note", "") or "")[:64]
    grant_mode = str(body.get("grant_mode", "regular") or "regular").strip()
    expires_raw = (body.get("expires_at") or "").strip()
    if tier not in ("trial", "stargazer", "voyager", "odyssey", "stella"):
        raise HTTPException(status_code=400, detail=f"非法的会员档位：{tier}")
    if tier != "stella" and (days is None or days <= 0):
        raise HTTPException(status_code=400, detail="非 Stella 档必须传正整数天数")
    if not 1 <= count <= 50:
        raise HTTPException(status_code=400, detail="数量须在 1~50 之间")
    if custom_code and count != 1:
        raise HTTPException(status_code=400, detail="自定义码一次只能生成一个")
    if grant_mode not in ("regular", "lump"):
        raise HTTPException(status_code=400, detail="grant_mode 须为 regular 或 lump")
    quantum_grant = None
    gravity_grant = None
    if grant_mode == "lump":
        q = body.get("quantum_grant")
        g = body.get("gravity_grant")
        if q is None or g is None:
            raise HTTPException(status_code=400, detail="一次性发放模式须指定 quantum_grant 与 gravity_grant")
        quantum_grant = int(q)
        gravity_grant = int(g)
        if quantum_grant < 0 or gravity_grant < 0:
            raise HTTPException(status_code=400, detail="发放额度不可为负")
    expires_at = None
    if expires_raw:
        try:
            expires_at = datetime.fromisoformat(expires_raw.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            raise HTTPException(status_code=400, detail="expires_at 格式错误（ISO 8601）")
    codes = []
    try:
        for _ in range(count):
            codes.append(await create_code(tier, days, note=note, custom_code=custom_code,
                                           expires_at=expires_at, grant_mode=grant_mode,
                                           quantum_grant=quantum_grant, gravity_grant=gravity_grant))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    logger.info("[Admin] 生成兑换码: tier=%s days=%s count=%d operator=%s",
                tier, days, count, current_user.uid)
    return {"codes": codes}


@app.get("/api/admin/orders")
async def admin_list_orders(
    status: str | None = None,
    current_user: User = Depends(get_admin_user),
):
    """订单列表（默认全部；status 可筛 processed/grant_failed/unmapped_user 等）"""
    return {"items": await list_orders(status or None)}


@app.post("/api/admin/orders/{out_trade_no}/fulfill")
async def admin_fulfill_order(
    out_trade_no: str,
    req: Request,
    current_user: User = Depends(get_admin_user),
):
    """人工补发 {uid, tier, days}：开通会员 + 订单状态改 processed。
    敏感操作：body 须带 pin（PIN 二次验证）"""
    body = await req.json()
    await _check_admin_pin(current_user, body)
    uid = int(body.get("uid", 0) or 0)
    tier = str(body.get("tier", "")).strip()
    days = body.get("days")
    days = int(days) if days not in (None, "") else None
    if not uid or not tier:
        raise HTTPException(status_code=400, detail="缺少 uid 或 tier")
    try:
        return await fulfill_order(out_trade_no, uid, tier, days)
    except AdminError as e:
        raise HTTPException(status_code=404, detail=e.detail)
    except InsufficientError as e:
        raise HTTPException(status_code=400, detail=e.detail)


@app.post("/api/admin/orders/{out_trade_no}/recheck")
async def admin_recheck_order(
    out_trade_no: str,
    current_user: User = Depends(get_admin_user),
):
    """query-order 反查爱发电真实状态（网络/平台错误返回 502 友好信息，不 500）"""
    try:
        return await recheck_order(out_trade_no)
    except AdminError as e:
        raise HTTPException(status_code=502, detail=e.detail)


# ===== 管理后台：运营统计/工具 =====

@app.get("/api/admin/codes-summary")
async def admin_codes_summary(current_user: User = Depends(get_admin_user)):
    """兑换码汇总：总生成/已核销/未核销/按档位"""
    return await get_codes_summary()


@app.get("/api/admin/feature-usage")
async def admin_feature_usage(days: int = 7, current_user: User = Depends(get_admin_user)):
    """最近 N 天功能使用次数（billing_ledger 消耗类 feature）"""
    return await get_feature_usage(max(1, min(days, 90)))


@app.get("/api/admin/task/{task_id}/detail")
async def admin_task_detail(task_id: str, current_user: User = Depends(get_admin_user)):
    """任务详情档案：内存 tasks → 磁盘 _rehydrate → DB task_records + billing_ledger"""
    from admin_store import get_task_detail
    detail = await get_task_detail(task_id)
    if not detail:
        raise HTTPException(status_code=404, detail="任务不存在")
    # 融合运行时数据：内存 tasks 优先，磁盘重建兜底（md/summary 状态从 output 文件恢复）
    t = tasks.get(task_id)
    if not t:
        t = await _rehydrate_task(task_id)
    if t:
        # 从 ledger 汇总 charged_*（进程重启后 tasks 内存丢失，但 ledger 持久化）
        charged_min = t.get("charged_minutes")
        charged_q = t.get("charged_quantum")
        if not charged_min or not charged_q:
            for r in detail.get("ledger", []):
                if not charged_min and r["currency"] == "minute" and r["amount"] < 0:
                    charged_min = -r["amount"]
                if not charged_q and r["currency"] == "quantum" and r["amount"] < 0:
                    charged_q = -r["amount"]
        detail["runtime"] = {
            "status": t.get("status"),
            "progress": t.get("progress"),
            "video_title": t.get("video_title"),
            "subtitle_source": t.get("subtitle_source"),
            "md_status": t.get("md_status"),
            "summary_status": t.get("summary_status"),
            "charged_minutes": charged_min,
            "charged_quantum": charged_q,
            "actual_seg_tokens": t.get("actual_seg_tokens"),
            "actual_chars": t.get("actual_chars"),
            "error": t.get("error"),
        }
    return detail


@app.get("/api/admin/recent-tasks")
async def admin_recent_tasks(uid: int | None = None, tid: str | None = None,
                              current_user: User = Depends(get_admin_user)):
    """最近提取任务（100 条），可按 UID 或 task_id 过滤"""
    return {"items": await get_recent_tasks(uid_filter=uid, task_id=tid)}


@app.get("/api/admin/anon-usage")
async def admin_anon_usage(current_user: User = Depends(get_admin_user)):
    """匿名使用今日概况：IP 数/消耗分钟/额度上限"""
    return await get_anon_usage_today()


@app.get("/api/admin/health")
async def admin_health(current_user: User = Depends(get_admin_user)):
    """系统健康：运行任务数/DB 大小/磁盘剩余/uptime"""
    active = sum(1 for t in tasks.values() if t.get("status") != TaskStatus.COMPLETED)
    return await get_health(running_tasks=active)


@app.post("/api/admin/codes/{code}/revoke")
async def admin_revoke_code(
    code: str,
    req: Request,
    current_user: User = Depends(get_admin_user),
):
    """作废兑换码（仅未使用）：设 expires_at=now"""
    from redeem_store import revoke_code, RedeemError
    body = await req.json()
    await _check_admin_pin(current_user, body)
    try:
        await revoke_code(code)
        return {"ok": True}
    except RedeemError as e:
        raise HTTPException(status_code=409, detail=e.detail)


# ===== 反馈工单（V0.9.4）=====

@app.get("/api/admin/tickets")
async def admin_list_tickets(
    status: str | None = None,
    current_user: User = Depends(get_admin_user),
):
    """管理员：全部工单列表（可选状态筛选）"""
    from ticket_store import list_all_tickets
    return {"items": await list_all_tickets(status)}


@app.get("/api/admin/tickets/{tid}")
async def admin_get_ticket(
    tid: int,
    current_user: User = Depends(get_admin_user),
):
    """管理员：单条工单详情（含日志内容）"""
    from ticket_store import get_ticket_admin, read_log_content
    t = await get_ticket_admin(tid)
    if not t:
        raise HTTPException(status_code=404, detail="工单不存在")
    t["log_content"] = read_log_content(t.get("log_path"))
    return t


@app.post("/api/admin/tickets/{tid}/reply")
async def admin_reply_ticket(
    tid: int,
    req: AdminTicketReplyRequest,
    current_user: User = Depends(get_admin_user),
):
    """管理员：回复/关闭/重新打开工单（PIN 二次验证）"""
    from ticket_store import reply_ticket, TicketError
    await _check_admin_pin(current_user, {"pin": req.pin})
    try:
        result = await reply_ticket(tid, req.action, req.reply)
        return {"ok": True, "ticket": result}
    except TicketError as e:
        raise HTTPException(status_code=400, detail=e.detail)


# ===== 用户工单（V0.9.4，需登录）=====

@app.post("/api/tickets")
async def submit_ticket(
    req: CreateTicketRequest,
    current_user: User = Depends(get_current_user),
):
    """用户提交工单。bug 类后端强制抓诊断日志；suggestion 类看 attach_log。
    顺序：提交瞬间抓日志（反映当前 tasks 状态）→ 建工单拿 id → 写日志文件 → 回填 log_path。"""
    from ticket_store import create_ticket, update_ticket_log_path, write_log_file

    need_log = (req.category == "bug") or (req.category == "suggestion" and req.attach_log)
    # ① 先建工单拿 id（log_path 留空）
    ticket = await create_ticket(
        current_user.uid, title=req.title, category=req.category,
        description=req.description, occur_at=req.occur_at,
        repro_steps=req.repro_steps, contact=req.contact,
    )
    # ② 提交瞬间抓日志 → 落文件 → 回填
    if need_log:
        try:
            diag = await build_diagnostics(current_user.uid, app.version, tasks)
            if req.client_events:
                diag["client_events"] = req.client_events   # V0.10.1：前端操作日志
            log_path = write_log_file(ticket["id"], diag)
            await update_ticket_log_path(ticket["id"], log_path)
            ticket["has_log"] = True
        except Exception as e:
            logger.warning("[Ticket] 抓诊断日志失败 tid=%s: %s", ticket["id"], e)
            # 日志失败不阻断工单提交（工单本身已落库）
    return {"ok": True, "ticket": ticket}


@app.get("/api/tickets")
async def list_my_tickets(current_user: User = Depends(get_current_user)):
    """我的工单列表（含未读标记）"""
    from ticket_store import list_user_tickets
    return {"items": await list_user_tickets(current_user.uid)}


@app.get("/api/tickets/{tid}")
async def get_my_ticket(
    tid: int,
    current_user: User = Depends(get_current_user),
):
    """查看我的工单详情（owner 校验；点开即标记已读消红点）"""
    from ticket_store import get_ticket_for_user, mark_user_read
    t = await get_ticket_for_user(tid, current_user.uid)
    if not t:
        raise HTTPException(status_code=404, detail="工单不存在")
    await mark_user_read(tid, current_user.uid)
    t["unread"] = False
    return t


# ===== 核心管线（后台执行）=====

async def run_pipeline(
    task_id: str,
    source: TaskSource,
    url: str | None,
    sessdata: str | None,
):
    """B站链接的完整管线（async 包装，实际在线程池跑同步管线）。
    R2：信号量串行化，超出的请求排队（不再并发）。"""
    async with _pipeline_sem:
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

        # 音频用完即删：结果页全部操作（下载/概要/MD/解读）只依赖字幕文本，
        # 延长保留期只存文本（会员分档保留的存储成本因此几乎为零）
        Path(audio_path).unlink(missing_ok=True)

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
        # V0.12.3：登录用户内容只写 DB（见下方 save_task_content）；匿名任务无 task_records 行，保留文件写入
        _update_status(task_id, TaskStatus.EXPORTING, 90)
        srt_content = segments_to_srt(segments)
        if not task.get("owner_uid"):
            save_exports(task_id, srt_content, segmented_text)

        # ⑦ 统计埋点（登录用户才计数，未登录跳过）
        _incr_stats_sync(
            task.get("owner_uid"),
            videos_extracted=1,
            chars_transcribed=len(raw_text),
            tokens_used=seg_usage["prompt_tokens"] + seg_usage["completion_tokens"],
        )

        # ⑧ 计费结算（成功后；分钟按预估时长，分段按实际 usage）
        seg_tokens = seg_usage["prompt_tokens"] + seg_usage["completion_tokens"]
        task["actual_seg_tokens"] = seg_tokens   # 实际分段 tokens（前端"有理有据"展示）
        task["actual_chars"] = len(raw_text)      # 实际转写字数
        if task.get("owner_uid"):
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

            # V0.12.2: 写入 DB 内容列（COS 备份全覆盖）
            try:
                asyncio.run(save_task_content(
                    task_id, raw_text=raw_text, subtitle_srt=srt_content,
                ))
            except Exception as ce:
                logger.warning("[DB] 保存任务内容失败(内容仅在内存): %s", ce)

        # ✅ 完成
        _update_status(task_id, TaskStatus.COMPLETED, 100, extra={
            "video_title": video_title,
            "subtitle_srt": "available",
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
        # R3：匿名任务失败退还预占的当日体验额度（upload 管线无预占，见 fix_prompt 出入 1）
        task = tasks.get(task_id) or {}
        if not task.get("owner_uid") and task.get("est_minutes"):
            try:
                asyncio.run(refund_anon_minutes(
                    task.get("owner_ip", "unknown"), task["est_minutes"],
                ))
            except Exception as re:
                logger.warning("[Billing] 匿名额度退还失败(不影响主流程): %s", re)
    finally:
        running_tasks.discard(task_id)


async def run_pipeline_from_file(
    task_id: str,
    file_path: Path,
    sessdata: str | None,
):
    """文件上传管线（async 包装，实际在线程池跑同步管线）。
    R2：信号量串行化，超出的请求排队（不再并发）。"""
    async with _pipeline_sem:
        await asyncio.to_thread(_run_pipeline_from_file_sync, task_id, file_path, sessdata)


def _run_pipeline_from_file_sync(
    task_id: str,
    file_path: Path,
    sessdata: str | None,
):
    """文件上传管线同步实现（放线程池跑，不阻塞事件循环）。
    纯音频文件跳过抽音轨直接送 ASR；视频文件先 FFmpeg 抽音轨。"""
    import subprocess as _sp
    def _has_video_stream(p: Path) -> bool:
        """ffprobe 检测文件是否包含视频流；失败兜底返回 True（当视频处理）。"""
        try:
            probe = _sp.run(
                [FFPROBE_PATH, "-i", str(p), "-show_streams", "-v", "quiet"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=10,
            )
            return "codec_type=video" in probe.stdout
        except Exception:
            return True   # 探测失败，走安全路径（当视频抽音轨）

    try:
        _update_status(task_id, TaskStatus.EXTRACTING_AUDIO, 20)

        # ① 音频获取：纯音频直接用，视频抽音轨
        if _has_video_stream(file_path):
            result = extract_audio_from_file(file_path, task_id)
            audio_path = result["audio_path"]
            video_title = result["video_title"]
        else:
            audio_path = file_path
            video_title = file_path.stem
        Path(file_path).unlink(missing_ok=True)   # 原始上传文件用完即删

        # ② ASR
        _update_status(task_id, TaskStatus.TRANSCRIBING, 50)
        asr_result = transcribe_with_mimo(audio_path, task_id)
        segments = asr_result["segments"]
        Path(audio_path).unlink(missing_ok=True)  # 音频用完即删（延长保留只存文本）

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

        # ⑤ 导出（V0.12.3：登录用户只写 DB；匿名任务保留文件写入）
        _update_status(task_id, TaskStatus.EXPORTING, 90)
        srt_content = segments_to_srt(segments)
        if not task.get("owner_uid"):
            save_exports(task_id, srt_content, segmented_text)

        # ⑥ 统计埋点（登录用户才计数，未登录跳过）
        _incr_stats_sync(
            task.get("owner_uid"),
            videos_extracted=1,
            chars_transcribed=len(raw_text),
            tokens_used=seg_usage["prompt_tokens"] + seg_usage["completion_tokens"],
        )

        # ⑦ 计费结算（成功后）
        seg_tokens = seg_usage["prompt_tokens"] + seg_usage["completion_tokens"]
        task["actual_seg_tokens"] = seg_tokens   # 实际分段 tokens（前端"有理有据"展示）
        task["actual_chars"] = len(raw_text)      # 实际转写字数
        if task.get("owner_uid"):
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

            # V0.12.2: 写入 DB 内容列（COS 备份全覆盖）
            try:
                asyncio.run(save_task_content(
                    task_id, raw_text=raw_text, subtitle_srt=srt_content,
                ))
            except Exception as ce:
                logger.warning("[DB] 保存任务内容失败(内容仅在内存): %s", ce)

        _update_status(task_id, TaskStatus.COMPLETED, 100, extra={
            "video_title": video_title,
            "subtitle_srt": "available",
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
        # R3：匿名任务失败退还预占的当日体验额度（与 submit 管线一致）
        task = tasks.get(task_id) or {}
        if not task.get("owner_uid") and task.get("est_minutes"):
            try:
                asyncio.run(refund_anon_minutes(
                    task.get("owner_ip", "unknown"), task["est_minutes"],
                ))
            except Exception as re:
                logger.warning("[Billing] 匿名额度退还失败(不影响主流程): %s", re)
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


async def _generate_summary_background(task_id: str):
    """R2：async wrapper，信号量串行化后台概要生成；sync 实现丢线程池，不阻塞事件循环。"""
    async with _pipeline_sem:
        await asyncio.to_thread(_generate_summary_impl, task_id)


def _generate_summary_impl(task_id: str):
    """后台生成内容总结的同步实现：调用 LLM 将字幕浓缩为结构化概要。"""
    task = tasks.get(task_id)
    if not task:
        return

    raw_text = task.get("raw_text", "")
    try:
        summary_content, summary_usage = summarize_text(raw_text, task_id)

        # V0.12.2+: 写入 DB（唯一持久化；该功能 401 拦匿名，无需文件兜底）
        try:
            asyncio.run(save_task_content(task_id, summary_content=summary_content))
        except Exception as e:
            logger.warning("[DB] 保存概要内容失败(内容仅在内存): %s", e)

        task["summary_status"] = "ready"
        task["summary_error"] = None
        task["summary_content"] = summary_content   # 直接带回前端展示
        # 实际 tokens（前端"有理有据"展示，与扣费同源）
        total_tokens = summary_usage["prompt_tokens"] + summary_usage["completion_tokens"]
        task["summary_tokens"] = total_tokens
        # 计费结算（生成成功后才扣量子波）
        if task.get("owner_uid"):
            try:
                task["summary_cost"] = asyncio.run(
                    consume_quantum(task["owner_uid"], total_tokens, "summary", task_id)
                )
            except Exception as be:
                logger.warning("[Billing] 概要结算失败(不影响功能): %s", be)
        _incr_stats_sync(
            task.get("owner_uid"),
            tokens_used=total_tokens,
        )
        logger.info("[Summary] 总结完成: %s (%d 字符)", task_id, len(summary_content))

    except Exception as e:
        task["summary_status"] = "failed"
        task["summary_error"] = str(e)
        logger.error("[Summary] 总结失败: %s - %s", task_id, e)


async def _generate_md_background(task_id: str):
    """R2：async wrapper，信号量串行化后台 MD 生成；sync 实现丢线程池，不阻塞事件循环。"""
    async with _pipeline_sem:
        await asyncio.to_thread(_generate_md_impl, task_id)


def _generate_md_impl(task_id: str):
    """后台生成 Markdown 的同步实现：调用 LLM 将原始转录文本转为结构化 MD。"""
    task = tasks.get(task_id)
    if not task:
        return

    raw_text = task.get("raw_text", "")
    try:
        md_content, md_usage = text_to_markdown(raw_text, task_id)

        # V0.12.2+: 写入 DB（唯一持久化；该功能 401 拦匿名，无需文件兜底）
        try:
            asyncio.run(save_task_content(task_id, md_content=md_content))
        except Exception as e:
            logger.warning("[DB] 保存MD内容失败(内容仅在内存): %s", e)

        task["md_status"] = "ready"
        task["md_error"] = None
        # 实际 tokens（前端"有理有据"展示，与扣费同源）
        total_tokens = md_usage["prompt_tokens"] + md_usage["completion_tokens"]
        task["md_tokens"] = total_tokens
        # 计费结算（生成成功后才扣引力波）
        if task.get("owner_uid"):
            try:
                task["md_cost"] = asyncio.run(
                    consume_gravity(task["owner_uid"], total_tokens, "md", task_id)
                )
            except Exception as be:
                logger.warning("[Billing] MD 结算失败(不影响功能): %s", be)
        _incr_stats_sync(
            task.get("owner_uid"),
            md_notes=1,
            tokens_used=total_tokens,
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
