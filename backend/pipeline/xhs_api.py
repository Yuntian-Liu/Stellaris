"""
小红书直连层（V1.4.1，纯标准库）

背景：2026-09-16 起小红书对网页 UA 的 discovery 页强制登录墙
（302 → /login?redirectPath=<编码后的真实地址>），yt-dlp 的
XiaoHongShu extractor 全军覆没；但 App UA（discover/...）抓页面不受墙
（Zeabur 数据中心 IP 实测 200 且含完整视频数据），视频 CDN（xhscdn）也不封。
因此小红书链接不再走 yt-dlp，由本模块直连：
短链手动解析（302 链 + 登录墙包装解码）→ App UA 抓页 →
正则取 masterUrl/标题/时长 → CDN 下载 mp4 → 调用方 ffmpeg 抽音轨。
"""
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# App UA：网页 UA 吃登录墙，App 身份放行（2026-09-17 线上实测）
_APP_UA = "discover/9.46.1 (iPhone; iOS 17.0; Scale/3.00) Resolution"
_PAGE_HOST = "xiaohongshu.com"
_SHORT_HOSTS = ("xhslink.cn", "xhslink.com")
_CDN_HOST = "xhscdn.com"

# 不自动跟跳的 opener：302 链手动走（要识别登录墙包装）
_no_redirect_opener = urllib.request.build_opener(
    type("_NoRedirect", (urllib.request.HTTPRedirectHandler,), {
        "redirect_request": lambda self, req, fp, code, msg, h, newurl: None,
    })()
)


def is_xhs_url(url: str) -> bool:
    """是否小红书链接（长短链通吃；短链域名 .cn/.com 都出现过）"""
    return _PAGE_HOST in url or any(h in url for h in _SHORT_HOSTS)


def _host_allowed(url: str) -> bool:
    """SSRF 二道闸：只允许小红书自家域名（页面/短链）与 xhscdn（视频 CDN）"""
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return (host == _PAGE_HOST or host.endswith("." + _PAGE_HOST)
            or host in _SHORT_HOSTS
            or host == _CDN_HOST or host.endswith("." + _CDN_HOST))


def resolve_xhs_url(url: str) -> str:
    """手动跟 302 链（最多 5 跳）拿到最终笔记页 URL。
    登录墙包装（/login?redirectPath=...）解码后继续；越出小红书域名即拒绝。"""
    for _ in range(5):
        if not _host_allowed(url):
            raise ValueError("不支持的链接地址（非小红书域名）")
        req = urllib.request.Request(url, headers={"User-Agent": _APP_UA})
        try:
            resp = _no_redirect_opener.open(req, timeout=30)
            resp.close()
            return url   # 2xx：到底了
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location") if e.code in (301, 302, 303, 307, 308) else None
            if not loc:
                raise RuntimeError(f"小红书页面访问失败: HTTP {e.code}")
            url = urllib.parse.urljoin(url, loc)
            if "/login" in url:
                # 登录墙包装：redirectPath 里是编码后的真实地址（parse_qs 自带解码一层）
                rp = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("redirectPath", [None])[0]
                if not rp:
                    raise RuntimeError("小红书链接需要登录，无法解析")
                url = rp
    raise RuntimeError("小红书链接跳转次数过多")


def fetch_xhs_info(url: str) -> dict:
    """抓笔记页（App UA），正则取视频直链/标题/时长。
    返回 {"video_url", "title", "duration_sec}"""
    url = resolve_xhs_url(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": _APP_UA,
        "Referer": "https://www.xiaohongshu.com/",
    })
    resp = urllib.request.urlopen(req, timeout=30)
    try:
        html = resp.read(4 * 1024 * 1024).decode("utf-8", "replace")
    finally:
        resp.close()

    m = re.search(r'"masterUrl":"(https?[^"]+)"', html)
    if not m:
        raise RuntimeError("未能解析小红书视频地址（页面结构可能已变更）")
    video_url = m.group(1).replace("\\u002F", "/")
    if not _host_allowed(video_url):
        raise RuntimeError("视频地址异常（非小红书 CDN）")

    mt = re.search(r'"title":"([^"]*)"', html)
    title = (mt.group(1).strip() if mt else "") or "小红书视频"
    md = re.search(r'"duration":(\d+(?:\.\d+)?)', html)
    return {
        "video_url": video_url,
        "title": title[:200],
        "duration_sec": float(md.group(1)) if md else None,
    }


def download_xhs_video(url: str, dest: Path, timeout: int = 300) -> dict:
    """抓信息 + 流式下载视频到 dest（1MB 一块）。返回 fetch_xhs_info 的字典"""
    info = fetch_xhs_info(url)
    req = urllib.request.Request(info["video_url"], headers={
        "User-Agent": _APP_UA,
        "Referer": "https://www.xiaohongshu.com/",
    })
    resp = urllib.request.urlopen(req, timeout=timeout)
    try:
        with open(dest, "wb") as f:
            while chunk := resp.read(1 << 20):
                f.write(chunk)
    finally:
        resp.close()
    return info
