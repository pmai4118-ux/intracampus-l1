"""U02 browser acceptance with an injected test provider and intercepted RPC.
Run a dev server with the PUBLIC values documented in docs/u02-wallet.md first.
Uses an isolated Chromium, never a personal wallet/profile or Avalanche L1.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

OUT = Path(__file__).resolve().parents[2] / "artifacts" / "u02"
OUT.mkdir(parents=True, exist_ok=True)
A = "0x" + "11" * 20
B = "0x" + "22" * 20
PROVIDER = """(() => {
  const listeners = new Map();
  const s = {accounts: [], chain: '0x4f25', reject: false, unknown: false, calls: []};
  const emit = (event, value) => { for (const fn of listeners.get(event) || []) fn(value); };
  window.__walletTest = {s, emit, listeners};
  window.ethereum = {
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    removeListener(event, fn) { listeners.get(event)?.delete(fn); },
    async request({method, params}) {
      s.calls.push(method);
      if (method === 'eth_accounts') return s.accounts;
      if (method === 'eth_chainId') return s.chain;
      if (method === 'eth_requestAccounts') {
        if (s.reject) throw {code: 4001};
        s.accounts = ['0x1111111111111111111111111111111111111111']; return s.accounts;
      }
      if (method === 'wallet_switchEthereumChain') {
        if (s.reject) throw {code: 4001};
        if (s.unknown) throw {code: 4902};
        s.chain = params[0].chainId; emit('chainChanged', s.chain); return null;
      }
      if (method === 'wallet_addEthereumChain') { s.unknown = false; return null; }
      throw Error('Unexpected wallet operation: ' + method);
    }
  };
})();"""

def word(n):
    return hex(n)[2:].rjust(64, "0")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    rpc = {"fail": False, "chain": "0x4f25"}

    def handle_rpc(route):
        call = route.request.post_data_json
        method = call["method"]
        if rpc["fail"]:
            route.fulfill(status=503, body="{}", headers={"Access-Control-Allow-Origin": "*"})
            return
        if method == "eth_chainId":
            result = rpc["chain"]
        elif method == "eth_getBlockByNumber":
            result = {"number": "0x10", "timestamp": "0x64"}
        elif method == "eth_getBalance":
            result = hex(3000000000000000000000) if call["params"][0] == A else "0x0"
        elif method == "eth_call":
            data = call["params"][0]["data"]
            student = data[-40:] == A[2:]
            if data[:10] == "0xc8f74bb8":
                result = "0x" + word(1 if student else 0)
            elif data[:10] == "0x6016dd4a":
                result = "0x" + (word(1) + word(200) if student else word(0) + word(0))
            else:
                raise AssertionError("Unexpected calldata")
        else:
            raise AssertionError("Unexpected read RPC: " + method)
        route.fulfill(json={"jsonrpc": "2.0", "id": call["id"], "result": result},
                      headers={"Access-Control-Allow-Origin": "*"})

    page.route("http://127.0.0.1:18548/**", handle_rpc)
    page.goto("http://127.0.0.1:3000/student")
    page.wait_for_load_state("networkidle")
    watermark = "body::after { content: 'KIỂM THỬ · Ví & RPC giả lập'; position: fixed; bottom: 0; left: 0; z-index: 9999; padding: 4px 8px; background: #143c30; color: white; font: 11px sans-serif; pointer-events: none; }"
    page.add_style_tag(content=watermark)
    expect(page.get_by_text("Chưa tìm thấy ví", exact=True)).to_be_visible()
    page.screenshot(path=str(OUT / "no-wallet-mobile.png"), full_page=True)
    context.add_init_script(PROVIDER)
    page.reload()
    page.wait_for_load_state("networkidle")
    page.add_style_tag(content=watermark)
    expect(page.get_by_text("Chưa kết nối", exact=True).first).to_be_visible()
    page.evaluate("window.__walletTest.s.reject = true")
    page.get_by_role("button", name="Kết nối ví", exact=True).click()
    expect(page.get_by_text("Đã từ chối kết nối", exact=True)).to_be_visible()
    page.evaluate("window.__walletTest.s.reject = false")
    page.get_by_role("button", name="Kết nối ví", exact=True).click()
    expect(page.get_by_text("Đã xác minh dữ liệu", exact=True)).to_be_visible()
    expect(page.get_by_text("3.000 CAMPUS", exact=True)).to_be_visible()
    expect(page.get_by_text("Tier 1", exact=True)).to_be_visible()
    page.screenshot(path=str(OUT / "connected-mobile.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.evaluate("""() => { const t=window.__walletTest; t.s.chain='0xa869'; t.emit('chainChanged', t.s.chain); }""")
    expect(page.get_by_text("Sai mạng", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Chưa mở thanh toán")).to_be_disabled()
    page.screenshot(path=str(OUT / "wrong-chain-mobile.png"), full_page=True)
    page.evaluate("window.__walletTest.s.reject = true")
    page.get_by_role("button", name="Chuyển sang IntraCampus L1", exact=True).click()
    expect(page.get_by_text("Bạn đã từ chối chuyển mạng.", exact=False)).to_be_visible()
    page.evaluate("window.__walletTest.s.reject=false; window.__walletTest.s.unknown=true")
    page.get_by_role("button", name="Chuyển sang IntraCampus L1", exact=True).click()
    expect(page.get_by_text("Đã xác minh dữ liệu", exact=True)).to_be_visible()
    assert page.evaluate("window.__walletTest.s.calls.includes('wallet_addEthereumChain')")
    page.evaluate("""() => { const t=window.__walletTest; t.s.accounts=['0x2222222222222222222222222222222222222222']; t.emit('accountsChanged', t.s.accounts); }""")
    expect(page.get_by_text(B, exact=True)).to_be_visible()
    expect(page.get_by_text("0 CAMPUS", exact=True)).to_be_visible()
    expect(page.get_by_text("Tier 0", exact=True)).to_be_visible()
    rpc["fail"] = True
    page.get_by_role("button", name="Thử đọc lại", exact=True).click()
    expect(page.get_by_text("Không đọc được dữ liệu", exact=True)).to_be_visible()
    expect(page.get_by_text("Chưa xác minh tier", exact=True)).to_be_visible()
    page.screenshot(path=str(OUT / "rpc-error-mobile.png"), full_page=True)
    rpc["fail"] = False
    page.get_by_role("button", name="Thử đọc lại", exact=True).click()
    expect(page.get_by_text("Đã xác minh dữ liệu", exact=True)).to_be_visible()
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.screenshot(path=str(OUT / "connected-desktop.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.get_by_role("button", name="Ngắt kết nối", exact=True).click()
    expect(page.get_by_text("Chưa kết nối", exact=True).first).to_be_visible()
    page.get_by_role("button", name="Xem bản minh họa", exact=True).click()
    expect(page.get_by_text("Số dư mẫu · Chưa đọc từ ví", exact=True)).to_be_visible()
    assert page.evaluate("[...window.__walletTest.listeners.values()].reduce((n,s)=>n+s.size,0)") == 0
    page.get_by_role("button", name="Ví thật", exact=True).click()
    expect(page.get_by_text("Đã xác minh dữ liệu", exact=True)).to_be_visible()
    assert not page.evaluate("window.__walletTest.s.calls.some(m=>/sign|send/i.test(m))")
    assert not errors, errors
    report = {"environment": "isolated Chromium; injected EIP-1193 test provider + intercepted JSON-RPC; not physical wallet/L1",
              "viewports": ["390x844", "1440x1000"], "passed": ["no-wallet", "connection-refusal", "connect-tier1-balance",
              "wrong-chain", "switch-refusal", "add-and-switch-4902", "second-account-tier0-zero-balance", "rpc-error-retry",
              "disconnect", "demo-separation", "listener-cleanup", "no-transaction-or-signature", "no-horizontal-overflow"], "pageErrors": errors}
    (OUT / "browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True))
    browser.close()
