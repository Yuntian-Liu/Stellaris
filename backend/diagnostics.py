"""
诊断导出 — 内存环形日志缓冲 + 诊断包组装

用途：用户遇到 bug 时导出诊断包，帮助开发者定位。
隐私红线：只含请求者本人的数据；密钥一律只报"是否配置"（true/false）；
字幕/对话内容不导出（只导长度与状态）。
"""
import logging
import os
import platform
import shutil
import time
from collections import deque

from sqlalchemy import select, desc

from config import (
    IS_PROD, LLM_MODEL, MIMO_API_KEY, LLM_API_KEY, TURNSTILE_SITE_KEY,
    RESEND_API_KEY, TMP_DIR, DATA_DIR,
)
from database import async_session
from billing_store import UserBilling, BillingLedger, BILLING_TIERS
from stats_store import get_stats

# ===== 环形日志缓冲（生产无 .devlogs 也能取日志）=====
LOG_BUFFER: deque = deque(maxlen=500)


class _BufferHandler(logging.Handler):
    def emit(self, record):
        try:
            LOG_BUFFER.append({
                "ts": self.format_time(record),
                "level": record.levelname,
                "logger": record.name,
                "msg": record.getMessage()[:500],
            })
        except Exception:
            pass

    @staticmethod
    def format_time(record):
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(record.created))


_STARTED_AT = time.time()


def attach_log_buffer():
    """启动时挂到 root logger（uvicorn 日志默认传播到 root）"""
    root = logging.getLogger()
    handler = _BufferHandler(level=logging.INFO)
    root.addHandler(handler)


def _dir_size_mb(path) -> float:
    total = 0
    try:
        for dirpath, _, filenames in os.walk(path):
            for f in filenames:
                try:
                    total += os.path.getsize(os.path.join(dirpath, f))
                except OSError:
                    pass
    except OSError:
        pass
    return round(total / 1024 / 1024, 2)


async def build_diagnostics(uid: int, app_version: str, tasks: dict) -> dict:
    """组装诊断包（仅请求者本人数据）"""
    # ── 系统状态 ──
    disk = shutil.disk_usage(str(TMP_DIR))
    system = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "uptime_sec": int(time.time() - _STARTED_AT),
        "disk_free_mb": disk.free // 1024 // 1024,
        "tmp_dir_mb": _dir_size_mb(TMP_DIR),
        "data_dir_mb": _dir_size_mb(DATA_DIR),
        "tasks_in_memory": len(tasks),
    }

    # ── 配置标志（脱敏：只报是否配置）──
    config_flags = {
        "is_prod": IS_PROD,
        "llm_model": LLM_MODEL,
        "mimo_key_set": bool(MIMO_API_KEY),
        "llm_key_set": bool(LLM_API_KEY),
        "turnstile_set": bool(TURNSTILE_SITE_KEY),
        "resend_set": bool(RESEND_API_KEY),
    }

    # ── 用户上下文（本人）──
    user_ctx = {"uid": uid}
    try:
        user_ctx["stats"] = await get_stats(uid)
    except Exception:
        pass
    try:
        async with async_session() as session:
            b = await session.get(UserBilling, uid)
            if b:
                tier = BILLING_TIERS.get(b.membership_tier, BILLING_TIERS["free"])
                user_ctx["billing"] = {
                    "tier": b.membership_tier,
                    "minutes": {
                        "day": f"{b.minutes_day}/{tier['minutes_day']}",
                        "week": f"{b.minutes_week}/{tier['minutes_week']}",
                        "month": f"{b.minutes_month}/{tier['minutes_month']}",
                    },
                    "quantum": b.quantum_gift + b.quantum_perm,
                    "gravity": b.gravity,
                }
            ledger = await session.execute(
                select(BillingLedger).where(BillingLedger.user_uid == uid)
                .order_by(desc(BillingLedger.id)).limit(30)
            )
            user_ctx["recent_ledger"] = [
                {
                    "feature": r.feature, "currency": r.currency,
                    "amount": r.amount, "balance_after": r.balance_after,
                    "task_id": r.task_id,
                }
                for r in ledger.scalars()
            ]
    except Exception as e:
        user_ctx["billing_error"] = str(e)

    # ── 任务快照（不含内容，只含状态）──
    task_snapshots = [
        {
            "task_id": t.get("task_id"),
            "status": str(t.get("status")),
            "progress": t.get("progress"),
            "source_platform": t.get("source_platform"),
            "owner_uid": t.get("owner_uid"),
            "error": (t.get("error") or "")[:300] or None,
        }
        for t in list(tasks.values())[-20:]
    ]

    # ── 日志（最近 300 条 + 错误精选）──
    logs = list(LOG_BUFFER)[-300:]
    errors = [l for l in LOG_BUFFER if l["level"] in ("ERROR", "WARNING")][-50:]

    return {
        "meta": {
            "app": "Stellaris",
            "version": app_version,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "purpose": "诊断导出（脱敏：不含密钥/字幕内容/他人数据）",
        },
        "config_flags": config_flags,
        "system": system,
        "user": user_ctx,
        "tasks": task_snapshots,
        "recent_errors": errors,
        "recent_logs": logs,
    }
