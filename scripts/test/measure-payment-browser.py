"""Q01 browser evidence on the existing U04/U05 loopback Anvil fixture only."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.request import Request, ProxyHandler, build_opener

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("fixture", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--port", type=int, default=3116)
args = parser.parse_args()
cfg = json.loads((args.fixture / "public-config.json").read_text(encoding="utf-8"))
provenance = json.loads((args.fixture / "source-provenance.json").read_text(encoding="utf-8"))
origin = f"http://127.0.0.1:{args.port}"
for key in ("api", "rpcUrl"):
    assert re.fullmatch(r"http://127\.0\.0\.1:\d+", cfg[key]), "Use an isolated loopback fixture"
assert cfg["environment"] == "local-anvil" and cfg["chainId"] == 20261
assert not args.output.exists(), "Choose a fresh observations file"
http = build_opener(ProxyHandler({}))


def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    request = Request(cfg["rpcUrl"], body, {"Content-Type": "application/json"})
    with http.open(request, timeout=5) as response:
        result = json.load(response)
    assert "error" not in result, "Local RPC failed"
    return result["result"]


assert int(rpc("eth_chainId"), 16) == 20261 and "anvil" in rpc("web3_clientVersion").lower()
with http.open(origin + "/api/deployment", timeout=5) as response:
    front_manifest = json.load(response)
assert front_manifest == {**cfg["manifest"], "environment": "avalanche-l1"}, "Fixture frontend points to another deployment"

adapter = """(config) => {
  window.ethereum = {
    on() {}, removeListener() {},
    async request({method, params = []}) {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [config.payer];
      if (method === 'eth_sendTransaction') {
        await window.q01Mark('request');
        if (window.q01Reject) throw {code: 4001};
        await window.q01Mark('submit');
      }
      const response = await fetch(config.rpcUrl, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
      });
      const data = await response.json();
      if (data.error) throw data.error;
      if (method === 'eth_sendTransaction') await window.q01Mark('hash', data.result);
      return data.result;
    },
  };
}"""

started = time.monotonic_ns()
started_at = datetime.now(timezone.utc).isoformat()
rows, page_errors = [], []


def now_ms():
    return (time.monotonic_ns() - started) // 1_000_000


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    browser_version = browser.version
    for tier, payer in enumerate((cfg["normalAccount"], cfg["beneficiary"])):
        pos_context = browser.new_context(viewport={"width": 1440, "height": 1000})
        student_context = browser.new_context(viewport={"width": 390, "height": 844})
        active = {}

        def mark(_source, key, value=None):
            assert key not in active["marksMs"], f"Duplicate wallet {key} event"
            active["marksMs"][key] = now_ms()
            if key == "hash":
                active["txHash"] = value

        student_context.expose_binding("q01Mark", mark)
        student_context.add_init_script(f"({adapter})({json.dumps({'payer': payer, 'rpcUrl': cfg['rpcUrl']})})")
        pos = pos_context.new_page()
        student = student_context.new_page()
        for page in (pos, student):
            page.on("pageerror", lambda error: page_errors.append(str(error)))
        pos.goto(origin + "/pos")
        student.goto(origin + "/student")
        for i in range(4 if tier == 0 else 3):
            reject = tier == 0 and i == 0
            active = {"payer": payer, "tier": tier, "observed": "timeout", "marksMs": {}}
            # Anvil does not advance its head while idle. Refresh chain time before B01 derives TTL.
            rpc("evm_mine")
            with pos.expect_response(lambda response: response.request.method == "POST"
                                     and response.url.endswith("/api/invoices")) as created:
                pos.get_by_role("button", name=re.compile(r"^Tạo hóa đơn( mới)?$")).click()
            invoice = created.value.json()
            assert created.value.status == 201
            active.update(invoiceId=invoice["invoiceId"], envelope=invoice["envelope"])
            rows.append(active)
            student.locator("#student-invoice-payload").fill(invoice["qrPayload"])
            student.get_by_role("button", name="Kiểm tra hóa đơn", exact=True).click()
            quote = student.get_by_role("region", name="Hóa đơn đã xác minh")
            expect(quote.locator(".total-amount")).to_have_text(("2.700" if tier else "3.000") + " CAMPUS")
            student.evaluate("reject => { window.q01Reject = reject; }", reject)
            quote.get_by_role("button", name="Thanh toán bằng Core", exact=True).click()
            deadline = time.monotonic() + 20
            if reject:
                expect(quote.get_by_text(re.compile("từ chối"))).to_be_visible()
                assert "txHash" not in active and "submit" not in active["marksMs"]
                active["observed"] = "rejected"
                continue
            next_poll = 0
            # Both the receipt poll and the check for a visible, matching POS receipt use this process's clock.
            while time.monotonic() < deadline:
                tx = active.get("txHash")
                if tx:
                    marks = active["marksMs"]
                    if "receipt" not in marks and now_ms() >= next_poll:
                        next_poll = now_ms() + 50
                        receipt = rpc("eth_getTransactionReceipt", [tx])
                        if receipt is not None:
                            marks["receipt"] = now_ms()
                            if receipt["status"] == "0x0":
                                active["observed"] = "hash-observed"
                                break
                    if "pos" not in marks:
                        shown = pos.locator(".invoice-verified-preview").filter(has_text=tx)
                        if shown.count() and shown.is_visible():
                            assert shown.get_by_text("BIÊN NHẬN ĐÃ XÁC MINH", exact=True).is_visible()
                            marks["pos"] = now_ms()
                    if "receipt" in marks and "pos" in marks:
                        active["observed"] = "hash-observed"
                        break
                pos.wait_for_timeout(20)
            print(f"tier={tier} invoice={active['invoiceId']} outcome={active['observed']}", flush=True)
        pos_context.close()
        student_context.close()
    browser.close()

commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
assert commit == provenance["sourceRevision"], "UI copy came from a different revision"
observation = {"schemaVersion": 1, "source": "local-anvil", "context": {
    "appCommit": commit, "startedAt": started_at, "network": "Same Windows host, HTTP loopback, Anvil automine",
    "devices": f"Headless Edge {browser_version}: POS 1440×1000, Student 390×844",
    "wallet": "Injected EIP-1193; unlocked accounts on this temporary Anvil; no human approval time",
    "clock": "One Python monotonic clock; POS sampled every 20 ms plus command/RPC time; binding marks include browser IPC; 0 ms means same clock tick",
    "posPollMs": 2000, "receiptPollMs": 50, "planned": {"standard": 4, "sbt": 3},
}, "attempts": rows}
with args.output.open("x", encoding="utf-8") as out:
    json.dump(observation, out, ensure_ascii=False, indent=2)
assert not page_errors, page_errors
assert len(rows) == 7 and sum("pos" in row["marksMs"] for row in rows) == 6, "Incomplete local measurement"
