"""Q02: POS and Student browser acceptance against the isolated U05 Anvil harness."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from urllib.request import Request, ProxyHandler, build_opener

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("fixture", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--port", type=int, default=3117)
parser.add_argument("--record-dir", type=Path, help="Optional local Playwright recording directory")
args = parser.parse_args()
cfg = json.loads((args.fixture / "public-config.json").read_text(encoding="utf-8"))
provenance = json.loads((args.fixture / "source-provenance.json").read_text(encoding="utf-8"))
origin = f"http://127.0.0.1:{args.port}"
assert cfg["environment"] == "local-anvil" and cfg["chainId"] == 20261
for endpoint in (cfg["api"], cfg["rpcUrl"]):
    assert re.fullmatch(r"http://127\.0\.0\.1:\d+", endpoint), "Use the isolated loopback fixture"
http = build_opener(ProxyHandler({}))
cases, sends, errors = [], [], []


def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    request = Request(cfg["rpcUrl"], body, {"Content-Type": "application/json"})
    with http.open(request, timeout=5) as response:
        result = json.load(response)
    assert "error" not in result, "Anvil RPC failed"
    return result["result"]


def record(case, **evidence):
    cases.append({"case": case, "at": datetime.now(timezone.utc).isoformat(), "status": "PASS", **evidence})
    print("PASS " + case, flush=True)


def capture(page, name):
    page.evaluate("document.activeElement?.blur(); window.scrollTo(0,0)")
    page.wait_for_function("scrollY === 0")
    page.screenshot(path=str(args.output / (name + ".png")), full_page=True)


def label(page):
    page.add_style_tag(content="body::before{content:'BẢN GHI TRƯỚC · ANVIL LOCAL · VÍ GIẢ LẬP';display:block;background:#713c12;color:white;padding:8px;text-align:center;font:bold 13px system-ui}")


def open_page(page, route):
    page.goto(origin + route, wait_until="networkidle")
    label(page)


adapter = r"""({ payer, rpcUrl }) => {
  const listeners = new Map();
  let chainId = '0x4f25';
  window.q02Wallet = { reject: false, chain(value) {
    chainId = value;
    for (const handler of listeners.get('chainChanged') || []) handler(value);
  }};
  window.ethereum = {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeListener(name, handler) { listeners.get(name)?.delete(handler); },
    async request({method, params = []}) {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [payer];
      if (method === 'eth_chainId') return chainId;
      if (method === 'eth_sendTransaction' && window.q02Wallet.reject) throw {code:4001};
      const response = await fetch(rpcUrl, {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0', id:1, method, params})});
      const data = await response.json();
      if (data.error) throw data.error;
      if (method === 'eth_sendTransaction') await window.q02Send(data.result);
      return data.result;
    },
  };
}"""


def configure_student(browser, payer):
    context = browser.new_context(viewport={"width": 390, "height": 844}, permissions=["clipboard-read", "clipboard-write"])
    context.expose_binding("q02Send", lambda _source, value: sends.append(value))
    config = json.dumps({"payer": payer, "rpcUrl": cfg["rpcUrl"]})
    context.add_init_script(f"({adapter})({config})")
    return context


def issue(pos):
    # A fresh local block prevents a stale Anvil head from aging the invoice during setup.
    rpc("evm_mine")
    with pos.expect_response(lambda r: r.url.endswith("/api/invoices") and r.request.method == "POST") as created:
        pos.get_by_role("button", name=re.compile(r"^Tạo hóa đơn( mới)?$")).click()
    assert created.value.status == 201
    invoice = created.value.json()
    qr = pos.get_by_role("img", name=re.compile("Mã QR cho hóa đơn"))
    expect(qr).to_be_visible()
    assert qr.evaluate("img => img.complete && img.naturalWidth > 0")
    expect(pos.locator("#invoice-payload")).to_have_value(invoice["qrPayload"])
    return invoice


def paste(page, payload):
    page.locator("#student-invoice-payload").fill(payload)
    page.get_by_role("button", name="Kiểm tra hóa đơn", exact=True).click()


def check_paid(pos, student, invoice, tx, payer, tier):
    display = "2.700 CAMPUS" if tier else "3.000 CAMPUS"
    for page in (pos, student):
        panel = page.locator("div.invoice-verified-preview").filter(has_text=tx)
        expect(panel).to_be_visible(timeout=20000)
        expect(panel).to_contain_text(invoice["envelope"]["meta"]["invoiceCode"])
        expect(panel).to_contain_text(payer.lower(), ignore_case=True)
        expect(panel).to_contain_text(display)
    url = origin + "/api/invoices/" + invoice["invoiceId"] + "?txHash=" + tx
    with http.open(url, timeout=5) as response:
        paid = json.load(response)["receipt"]
    receipt = rpc("eth_getTransactionReceipt", [tx])
    assert receipt["status"] == "0x1" and receipt["transactionHash"] == tx
    assert paid["invoiceId"] == invoice["invoiceId"] and paid["txHash"] == tx and paid["chainId"] == 20261
    assert paid["payer"].lower() == payer.lower() and paid["tier"] == tier
    assert paid["contractAddress"].lower() == cfg["registry"].lower()
    assert paid["merchant"].lower() == cfg["manifest"]["merchants"]["parking"]["address"].lower()
    assert paid["originalAmount"] == str(3000 * 10**18)
    assert paid["discountAmount"] == str((300 if tier else 0) * 10**18)
    assert paid["paidAmount"] == str((2700 if tier else 3000) * 10**18)
    assert any(log["address"].lower() == cfg["registry"].lower()
               and int(log["logIndex"], 16) == paid["logIndex"]
               and log["topics"][0] == "0x92a65d73263650a30865358a778394e3b70520f6a2064b6a6ee3af7bae30ee2d"
               and log["topics"][1] == invoice["invoiceId"] for log in receipt["logs"])
    return {"verifiedReceipt": paid, "rpcReceipt": receipt}


assert int(rpc("eth_chainId"), 16) == 20261 and "anvil" in rpc("web3_clientVersion").lower()
with http.open(origin + "/api/deployment", timeout=5) as response:
    assert json.load(response) == {**cfg["manifest"], "environment": "avalanche-l1"}
assert all(rpc("eth_getCode", [contract["address"], "latest"]) != "0x" for contract in cfg["manifest"]["contracts"].values())
args.output.mkdir(parents=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    browser_name = f"Microsoft Edge {browser.version} headless"
    recording = {"record_video_dir": str(args.record_dir), "record_video_size": {"width": 1280, "height": 900}} if args.record_dir else {}
    for tier, payer in enumerate((cfg["normalAccount"], cfg["beneficiary"])):
        pos_context = browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"], **(recording if tier == 1 else {}))
        student_context = configure_student(browser, payer)
        pos, student = pos_context.new_page(), student_context.new_page()
        for page in (pos, student):
            page.on("pageerror", lambda error: errors.append(str(error)))
        open_page(pos, "/pos")
        open_page(student, "/student")
        invoice = issue(pos)
        pos.get_by_role("button", name="Sao chép payload QR", exact=True).click()
        payload = pos.evaluate("navigator.clipboard.readText()")
        assert payload == invoice["qrPayload"]

        if tier == 0:
            student.evaluate("window.q02Wallet.chain('0xa869')")
            student.locator("#student-invoice-payload").fill(payload)
            expect(student.get_by_role("button", name="Kiểm tra hóa đơn", exact=True)).to_be_disabled()
            assert len(sends) == 0
            student.evaluate("window.q02Wallet.chain('0x4f25')")
            expect(student.get_by_role("button", name="Kiểm tra hóa đơn", exact=True)).to_be_enabled()
            record("wrong-wallet-chain", broadcasts=0)
            student.route(cfg["rpcUrl"], lambda route: route.abort())
            paste(student, payload)
            expect(student.locator("#student-invoice-error")).to_contain_text("Không xác minh")
            assert len(sends) == 0
            student.unroute(cfg["rpcUrl"])
            record("rpc-unavailable-before-send", broadcasts=0)

        paste(student, payload)
        quote = student.get_by_role("region", name="Hóa đơn đã xác minh")
        expect(quote.locator(".total-amount")).to_have_text(("2.700" if tier else "3.000") + " CAMPUS")
        pay = quote.get_by_role("button", name="Thanh toán bằng Core", exact=True)
        if tier == 0:
            student.evaluate("window.q02Wallet.reject = true")
            pay.click()
            expect(quote.get_by_text(re.compile("từ chối ký"))).to_be_visible()
            assert len(sends) == 0
            student.evaluate("window.q02Wallet.reject = false")
            record("wallet-rejected", broadcasts=0)

        if tier == 1:
            rpc("evm_setAutomine", [False])
        try:
            pay.click()
            # A quickly confirmed transaction adds a second hash label inside Receipt.
            expect(quote.locator(".invoice-payment-panel > code.tx-hash-code")).to_be_visible()
            tx = sends[-1]
            assert len(sends) == tier + 1
            if tier == 1:
                expect(pos.locator("#pos-payment-status")).to_have_text("Chờ thanh toán / xác minh")
                expect(quote.get_by_text(tx, exact=True)).to_be_visible()
                assert rpc("eth_getTransactionReceipt", [tx]) is None
                capture(student, "student-payment-pending")
                capture(pos, "pos-payment-pending")
                record("hash-before-receipt", invoiceId=invoice["invoiceId"], txHash=tx)
                student.reload(wait_until="networkidle")
                label(student)
                recovery = student.get_by_role("region", name="Khôi phục thanh toán")
                expect(recovery.get_by_text(tx, exact=True)).to_be_visible()
                expect(student.get_by_role("button", name="Thanh toán bằng Core", exact=True)).to_have_count(0)
                assert len(sends) == 2
                rpc_error = {"invoiceId": invoice["invoiceId"], "envelope": invoice["envelope"],
                             "status": "rpc-error", "lastKnownStatus": "pending", "receipt": None,
                             "transaction": {"txHash": tx, "status": "unverified"}, "updatedAt": None,
                             "error": {"code": "RPC_UNAVAILABLE", "message": "RPC không khả dụng trong ca kiểm thử.",
                                       "nextStep": "Giữ hash cũ và tra cứu lại.", "retryable": True}}
                # Inject the HTTP failure at the browser boundary without disrupting the shared fixture.
                endpoint = "**/api/invoices/" + invoice["invoiceId"] + "?txHash=*"
                student.route(endpoint, lambda route: route.fulfill(status=503, json=rpc_error))
                recovery.get_by_role("button", name="Tra cứu kết quả cũ").click()
                expect(recovery.get_by_text(re.compile("Mất kết nối xác minh"))).to_be_visible()
                expect(recovery.get_by_text(tx, exact=True)).to_be_visible()
                assert len(sends) == 2
                capture(student, "student-payment-rpc-error")
                student.unroute(endpoint)
                record("pending-reload-and-injected-http-503", invoiceId=invoice["invoiceId"], txHash=tx, broadcastCount=1)
                rpc("evm_mine")
                recovery.get_by_role("button", name="Tra cứu kết quả cũ").click()
            proof = check_paid(pos, student, invoice, tx, payer, tier)
            assert len(sends) == tier + 1
            name = "sbt" if tier else "standard"
            capture(student, "student-payment-" + name)
            pos.locator(".invoice-verified-preview").scroll_into_view_if_needed()
            if tier == 1 and args.record_dir:
                # Include the actual confirmed receipt in the screen recording.
                pos.wait_for_timeout(1800)
            capture(pos, "pos-payment-" + name)
            record("payment-" + name, **proof)
        finally:
            if tier == 1:
                rpc("evm_setAutomine", [True])

        if args.record_dir and tier == 1:
            video = pos.video
        pos_context.close()
        student_context.close()
        if args.record_dir and tier == 1:
            video.save_as(str(args.record_dir / "pos-sbt.webm"))

    pos_context = browser.new_context(viewport={"width": 1280, "height": 900})
    student_context = configure_student(browser, cfg["normalAccount"])
    pos, student = pos_context.new_page(), student_context.new_page()
    for page in (pos, student):
        page.on("pageerror", lambda error: errors.append(str(error)))
    open_page(pos, "/pos")
    open_page(student, "/student")
    expired = issue(pos)
    rpc("evm_increaseTime", [301])
    rpc("evm_mine")
    paste(student, expired["qrPayload"])
    expect(student.locator("#student-invoice-error")).to_contain_text("hết hạn")
    assert len(sends) == 2
    capture(student, "student-payment-expired")
    record("expired-qr", invoiceId=expired["invoiceId"], broadcasts=0)
    browser.close()

assert not errors, errors
report = {"environment": "local-anvil", "runner": "Codex", "browser": browser_name,
          "viewports": {"POS": "1280x900", "Student": "390x844"}, "network": "HTTP loopback",
          "wallet": "Injected EIP-1193 using the temporary Anvil accounts", "chainId": 20261,
          "deployment": cfg["manifest"], "provenance": provenance, "cases": cases, "broadcasts": sends, "pageErrors": errors}
(args.output / "browser-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
