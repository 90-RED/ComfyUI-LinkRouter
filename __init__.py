import json
import os
from datetime import datetime

from aiohttp import web
from server import PromptServer

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

# The frontend profiler POSTs each finished report here — browser JS cannot
# write to disk directly. Files land in custom_nodes/.disabled/LinkRouter_log.
_LOG_DIR = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        os.pardir,
        ".disabled",
        "LinkRouter_log",
    )
)


@PromptServer.instance.routes.post("/linkrouter/write_log")
async def _linkrouter_write_log(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"LinkRouter_{stamp}.json"
        path = os.path.join(_LOG_DIR, name)
        n = 1
        while os.path.exists(path):
            name = f"LinkRouter_{stamp}_{n}.json"
            path = os.path.join(_LOG_DIR, name)
            n += 1
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return web.json_response({"ok": True, "file": name})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
