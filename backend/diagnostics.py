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
    IS_PROD, LLM_MODEL, MIMO_API_KEY, LLM_API_KEY,
    RESEND_API_KEY, TMP_DIR, DATA_DIR,
    AFDIAN_USER_ID, AFDIAN_API_TOKEN, AFDIAN_SHOP_URL, AFDIAN_PLAN_MAP,
    JWT_SECRET, COS_SECRET_ID, VAULT_TOKEN,
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
    """启动时挂到 root logger（uvicorn 日志默认传播到 root）。
    两件事（V1.0.4 实锤的日志黑洞）：
    1. root 级别提到 INFO——默认 WARNING 会静默丢弃 [LLM]/[Backup] 等 INFO 日志
    2. root 补 StreamHandler——uvicorn 只给自己的 logger 配控制台，业务日志此前
       不进 stdout（备份谜案时 Zeabur 日志面板找不到 [Backup] 行的根因）"""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(_BufferHandler(level=logging.INFO))
    if not any(getattr(h, "_stellaris_console", False) for h in root.handlers):
        console = logging.StreamHandler()
        console._stellaris_console = True   # 标记防热重载重复添加
        console.setLevel(logging.INFO)
        console.setFormatter(logging.Formatter("%(message)s"))
        root.addHandler(console)


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
    import json as _json
    try:
        plan_map_count = len(_json.loads(AFDIAN_PLAN_MAP or "{}"))
    except _json.JSONDecodeError:
        plan_map_count = -1   # JSON 解析失败（配置错误，诊断要看见）
    # V1.1.0：模型仓库生效值（排障关键——模型可能已被后台切换，env 默认值不再代表实际）
    from model_store import get_llm_active, get_asr_model
    llm_provider, llm_model_active = get_llm_active()
    config_flags = {
        "is_prod": IS_PROD,
        "llm_model": llm_model_active,
        "llm_provider": llm_provider,
        "asr_model": get_asr_model(),
        "mimo_key_set": bool(MIMO_API_KEY),
        "llm_key_set": bool(LLM_API_KEY),
        # V1.2.2 起人机验证自托管（auth/captcha.py），无外部密钥，turnstile_set 退役
        "captcha": "self-hosted",
        "resend_set": bool(RESEND_API_KEY),
        # 爱发电（V0.8.0 会员支付链路）
        "afdian_user_id_set": bool(AFDIAN_USER_ID),
        "afdian_token_set": bool(AFDIAN_API_TOKEN),
        "afdian_shop_url_set": bool(AFDIAN_SHOP_URL),
        "afdian_plan_map_count": plan_map_count,
        # 备份与安全（V1.0.3 扩充：备份谜案/安全审查后补）
        "cos_backup_set": bool(COS_SECRET_ID),
        "jwt_secret_set": JWT_SECRET != "dev-secret-change-me",
        # 文件柜（V1.1.3：只报布尔——token/密码本身永不导出；vault 内容/路径绝不进诊断包）
        "vault_token_set": bool(VAULT_TOKEN),
    }

    # ── 备份状态（V1.0.3：上次备份结果，排查备份问题免上服务器）──
    backup_info = None
    try:
        from backup_store import _last_backup
        if _last_backup:
            backup_info = {
                "time": _last_backup.get("time_iso"),
                "ok": _last_backup.get("ok"),
                "uploaded": _last_backup.get("uploaded"),
                "snapshot_size_kb": round((_last_backup.get("snapshot_size") or 0) / 1024, 1),
                "msg": _last_backup.get("msg"),
            }
    except Exception:
        pass

    # ── 用户上下文（本人）──
    user_ctx = {"uid": uid}
    try:
        user_ctx["stats"] = await get_stats(uid)
    except Exception:
        pass
    try:
        # 有效档位（含 admin 覆盖/到期降级），分钟限额按档位显示
        from billing_store import _effective_tier_key
        from auth.models import User as AuthUser
        async with async_session() as session:
            u = (await session.execute(
                select(AuthUser).where(AuthUser.uid == uid))).scalar_one_or_none()
            user_ctx["is_admin"] = bool(u and u.is_admin)
            user_ctx["admin_pin_set"] = bool(u and u.admin_pin_hash)  # 管理密码已设置（V0.9.0）
            user_ctx["vault_pass_set"] = bool(u and u.vault_pass_hash)  # 文件柜专用密码已设置（V1.1.3）
            # 用户版文件柜（V1.2.0 内测）：只报开关/配额/用量数字——文件路径与内容绝不进诊断包
            user_ctx["vault_enabled"] = bool(u and u.vault_enabled)
            user_ctx["vault_quota_mb"] = u.vault_quota_mb if u and u.vault_quota_mb is not None else 5
            if u and u.vault_enabled:
                from vault_store import user_used_bytes
                used_b, file_n = await user_used_bytes(u.uid)
                user_ctx["vault_used_bytes"] = used_b
                user_ctx["vault_files"] = file_n
            # 内测申请状态（V1.2.1 改报推导后状态，与实验室所见一致；只报状态，不含内容）
            if u and u.vault_enabled:
                user_ctx["vault_apply_status"] = "approved"
            elif u and u.vault_rejected_at:
                user_ctx["vault_apply_status"] = "rejected"
                # 被拒时间：冷却类问题（"为什么还不能申请"）的定位依据；本人自己的时间戳，可导出
                user_ctx["vault_rejected_at"] = u.vault_rejected_at.isoformat() + "Z"
            else:
                from ticket_store import SupportTicket
                latest_apply = (await session.execute(
                    select(SupportTicket.id).where(SupportTicket.user_uid == uid,
                                                   SupportTicket.category == "vault_apply")
                    .limit(1)
                )).first()
                user_ctx["vault_apply_status"] = "pending" if latest_apply else "none"
            b = await session.get(UserBilling, uid)
            if b:
                tier_key = await _effective_tier_key(session, b)
                tier = BILLING_TIERS.get(tier_key, BILLING_TIERS["free"])
                unlimited = bool(tier.get("unlimited"))

                def _lim(used, limit):
                    if unlimited:
                        return f"{used}/∞"
                    return f"{used}/{limit if limit is not None else '∞'}"

                user_ctx["billing"] = {
                    "tier": tier_key,
                    "tier_db": b.membership_tier,   # 库内原始档位（购买记录，可能与有效档位不同）
                    "membership_expire_at": b.membership_expire_at.isoformat() if b.membership_expire_at else None,
                    "gravity_grant_at": b.gravity_grant_at.isoformat() if b.gravity_grant_at else None,
                    "minutes": {
                        "day": _lim(b.minutes_day, tier.get("minutes_day")),
                        "week": _lim(b.minutes_week, tier.get("minutes_week")),
                        "month": _lim(b.minutes_month, tier.get("minutes_month")),
                    },
                    "quantum_gift": b.quantum_gift,
                    "quantum_perm": b.quantum_perm,
                    "gravity": b.gravity,
                    "exchange_month": f"{b.exchange_month_count}/{tier.get('exchange_cap', 5) if not tier.get('exchange_unlimited') else '∞'}",
                    "history_hours": tier.get("history_hours"),
                }
            ledger = await session.execute(
                select(BillingLedger).where(BillingLedger.user_uid == uid)
                .order_by(desc(BillingLedger.id)).limit(30)
            )
            user_ctx["recent_ledger"] = [
                {
                    "feature": r.feature, "currency": r.currency,
                    "amount": r.amount, "balance_after": r.balance_after,
                    "from_gift": r.from_gift, "from_perm": r.from_perm,
                    "task_id": r.task_id,
                    # V1.1.0 发票列（成本/模型类排障必需；老行为 None）
                    "model": r.model, "cost_yuan": r.cost_yuan,
                    "prompt_tokens": r.prompt_tokens,
                    "completion_tokens": r.completion_tokens,
                    "cache_hit_tokens": r.cache_hit_tokens,
                    "cache_miss_tokens": r.cache_miss_tokens,
                }
                for r in ledger.scalars()
            ]
            # 爱发电订单 + 兑换记录（本人）
            from afdian_store import AfdianOrder
            from redeem_store import RedeemCode
            orders = await session.execute(
                select(AfdianOrder).where(AfdianOrder.user_uid == uid)
                .order_by(desc(AfdianOrder.created_at)).limit(10)
            )
            user_ctx["afdian_orders"] = [
                {"out_trade_no": o.out_trade_no, "status": o.status,
                 "amount": o.total_amount}
                for o in orders.scalars()
            ]
            redeems = await session.execute(
                select(RedeemCode).where(RedeemCode.used_by == uid)
                .order_by(desc(RedeemCode.used_at)).limit(10)
            )
            user_ctx["redemptions"] = [
                {"tier": r.tier, "days": r.days, "note": r.note}
                for r in redeems.scalars()
            ]
            # 历史记录数（分档保留排查用）
            from history_store import TaskRecord
            from sqlalchemy import func as _func
            rec_count = (await session.execute(
                select(_func.count()).select_from(TaskRecord)
                .where(TaskRecord.owner_uid == uid)
            )).scalar_one()
            user_ctx["task_records_count"] = rec_count
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
            "rehydrated": bool(t.get("rehydrated")),   # 冷启动重建标记（V0.8.0）
            "error": (t.get("error") or "")[:300] or None,
        }
        for t in list(tasks.values())[-20:]
    ]

    # ── 日志（最近 300 条 + 错误精选）──
    logs = list(LOG_BUFFER)[-300:]
    errors = [l for l in LOG_BUFFER if l["level"] in ("ERROR", "WARNING")][-50:]

    # V1.2.2 LLM 调用健康（SOP ④.1）：近 24h 汇总数字——AI 罢工类问题免等用户工单
    llm_health = None
    try:
        from llm_events_store import get_llm_health
        h = await get_llm_health()
        llm_health = {"h24": h["h24"], "d7_total": h["d7"]["total"],
                      "d7_empty": h["d7"]["empty"], "d7_length": h["d7"]["length"]}
    except Exception:
        llm_health = None

    return {
        "meta": {
            "app": "Stellaris",
            "version": app_version,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "purpose": "诊断导出（脱敏：不含密钥/字幕内容/他人数据）",
        },
        "config_flags": config_flags,
        "system": system,
        "backup": backup_info,
        "llm_health": llm_health,
        "user": user_ctx,
        "tasks": task_snapshots,
        "recent_errors": errors,
        "recent_logs": logs,
    }
