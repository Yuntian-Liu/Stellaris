"""
B站官方 API 直连层（纯标准库，无新增依赖）

背景：yt-dlp 的 BiliBili extractor 第一步必抓视频 HTML 页面，
B站对数据中心 IP 的网页抓取一律 412。V1.3.x 走 api.bilibili.com
JSON 接口绕过；2026-09-16 起 view 接口也被 412（V1.4.1），
playurl/CDN 仍通 → 元数据改从 m.bilibili.com 移动站页面解析
（__INITIAL_STATE__ 内嵌完整 viewInfo），playurl 照旧。
"""
import json
import re
import urllib.request
from pathlib import Path

# 浏览器 UA，B站 API 要求带 UA + Referer，否则 403
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
       "AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/128.0.0.0 Safari/537.36")

_BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")

# 移动浏览器 UA（V1.4.1：web-interface/view 接口已被数据中心 IP 412，
# m.bilibili.com 移动站未被风控，__INITIAL_STATE__ 内嵌完整元数据）
_MUA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
        "Mobile/15E148 Safari/604.1")

# 不跟随 302 的 opener：b23.tv 短链只取 Location 头，
# 不能跟跳——跳转目标是视频 HTML 页，正是被 412 风控的那步
_no_redirect_opener = urllib.request.build_opener(
    type("_NoRedirect", (urllib.request.HTTPRedirectHandler,), {
        "redirect_request": lambda self, req, fp, code, msg, h, newurl: None,
    })()
)


def is_bilibili_url(url: str) -> bool:
    """是否 B站链接（含 b23.tv 短链）——是则走本模块，否则走 yt-dlp"""
    return "bilibili.com" in url or "b23.tv" in url


def _open(url: str, sessdata: str | None = None, timeout: int = 30,
          ua: str = _UA):
    """带浏览器 UA + Referer 发请求；有 SESSDATA 时带上（会员视频/更松风控）"""
    headers = {"User-Agent": ua, "Referer": "https://www.bilibili.com"}
    if sessdata:
        headers["Cookie"] = f"SESSDATA={sessdata}"
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def _extract_initial_state(html: str) -> dict:
    """花括号配平截取 window.__INITIAL_STATE__（跳过字符串内部）后 JSON 解析"""
    i = html.find("window.__INITIAL_STATE__=")
    if i < 0:
        raise RuntimeError("移动站页面结构异常（无 __INITIAL_STATE__）")
    i += len("window.__INITIAL_STATE__=")
    depth, j, in_str, esc = 0, i, False, False
    while j < len(html):
        c = html[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return json.loads(html[i:j + 1])
        j += 1
    raise RuntimeError("移动站页面结构异常（__INITIAL_STATE__ 不完整）")


def resolve_bvid(url: str, sessdata: str | None = None) -> str:
    """从链接提取 BV 号；b23.tv 短链只读 302 的 Location 头（不跟跳 HTML 页）"""
    if "b23.tv" in url:
        headers = {"User-Agent": _UA, "Referer": "https://www.bilibili.com"}
        if sessdata:
            headers["Cookie"] = f"SESSDATA={sessdata}"
        req = urllib.request.Request(url, headers=headers)
        try:
            resp = _no_redirect_opener.open(req, timeout=30)
            try:
                url = resp.headers.get("Location", "")
            finally:
                resp.close()
        except urllib.error.HTTPError as e:
            # 不跟跳时 302 会以异常形式抛出，Location 就在异常头里
            if e.code in (301, 302, 303, 307, 308):
                url = e.headers.get("Location", "")
            else:
                raise
    m = _BV_RE.search(url)
    if not m:
        raise RuntimeError(f"无法从链接解析 BV 号: {url}")
    return m.group(1)


def fetch_video_info(bvid: str, sessdata: str | None = None) -> dict:
    """拿元数据。返回 {bvid, cid, title, duration_sec}
    主路 view API（住宅 IP 正常）；V1.4.1：2026-09-16 起数据中心 IP 被 412
    → 回落 m.bilibili.com 移动站页面解析（线上实测未被风控）"""
    try:
        resp = _open(
            f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
            sessdata,
        )
        try:
            d = json.loads(resp.read())
        finally:
            resp.close()
        if d.get("code") != 0:
            raise RuntimeError(f"B站接口错误: {d.get('message', d.get('code'))}")
        v = d["data"]
        return {
            "bvid": bvid,
            "cid": v["cid"],
            "title": (v.get("title") or "Unknown Title")[:200],
            "duration_sec": float(v["duration"]),
        }
    except Exception:
        pass
    # 回落：移动站页面（__INITIAL_STATE__.video.viewInfo）
    resp = _open(f"https://m.bilibili.com/video/{bvid}", sessdata, ua=_MUA)
    try:
        html = resp.read().decode("utf-8", "replace")
    finally:
        resp.close()
    v = _extract_initial_state(html)["video"]["viewInfo"]
    return {
        "bvid": bvid,
        "cid": v["cid"],
        "title": (v.get("title") or "Unknown Title")[:200],
        "duration_sec": float(v["duration"]),
    }


def fetch_audio_url(bvid: str, cid: int, sessdata: str | None = None) -> str:
    """playurl API 拿 DASH 音频直链（fnval=16），取码率最高的一路"""
    resp = _open(
        f"https://api.bilibili.com/x/player/playurl"
        f"?bvid={bvid}&cid={cid}&fnval=16&fnver=0",
        sessdata,
    )
    try:
        d = json.loads(resp.read())
    finally:
        resp.close()
    if d.get("code") != 0:
        raise RuntimeError(f"B站接口错误: {d.get('message', d.get('code'))}")
    audios = d["data"].get("dash", {}).get("audio") or []
    if not audios:
        raise RuntimeError("未获取到音频流（视频可能受限或需登录，可尝试填写 SESSDATA）")
    best = max(audios, key=lambda a: a.get("bandwidth", 0))
    return best["baseUrl"]


def download_to_file(
    url: str,
    dest: Path,
    sessdata: str | None = None,
    timeout: int = 300,
) -> None:
    """流式下载 CDN 音频到本地文件（B站 CDN 校验 Referer，必须带头）"""
    resp = _open(url, sessdata, timeout=timeout)
    try:
        with open(dest, "wb") as f:
            while chunk := resp.read(1 << 20):   # 1MB 一块
                f.write(chunk)
    finally:
        resp.close()
