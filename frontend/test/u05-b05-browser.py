"""Actual Student UI + B05 HTTP + Anvil. Requires Python Playwright and Edge.

The only doubles are the EIP-1193 wallet interface and the explicitly labelled
HTTP failure case. No user RPC, wallet key, production manifest or QR is used.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("fixture", type=Path, help="Ignored fixture directory containing public-config.json")
parser.add_argument("output", type=Path, help="New public evidence directory")
parser.add_argument("--origin", default="http://127.0.0.1:3105")
args = parser.parse_args()
from playwright.sync_api import sync_playwright, expect

cfg = json.loads((args.fixture / "public-config.json").read_text(encoding="utf-8"))
provenance = json.loads((args.fixture / "source-provenance.json").read_text(encoding="utf-8"))
assert cfg["environment"] == "local-anvil" and cfg["chainId"] == 20261
assert cfg["rpcUrl"].startswith("http://127.0.0.1:") and args.origin.startswith("http://127.0.0.1:")
assert not args.output.exists(), "Choose a fresh evidence directory; existing evidence is preserved"
args.output.mkdir(parents=True)
http = build_opener(ProxyHandler({}))
cases, sends, errors = [], [], []

def rpc(method, params=None):
    req = Request(cfg["rpcUrl"], json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or []}).encode(), {"Content-Type":"application/json"})
    data = json.load(http.open(req, timeout=10))
    assert "error" not in data, data.get("error")
    return data["result"]

def lookup(account, tx=None):
    return json.load(http.open(cfg["api"] + "/api/grants/" + account + ("?txHash=" + tx if tx else ""), timeout=10))

def passed(name, **proof):
    cases.append({"name":name, **proof})
    print("PASS " + name, flush=True)

provider_script = r"""(config) => {
  const listeners = new Map();
  const w = { account:config.account, chain:'0x4f25', mode:'normal', holdAccounts:false, lastHash:null };
  const emit=(name,value)=>(listeners.get(name)||[]).forEach(fn=>fn(value));
  w.setAccount=a=>{w.account=a;emit('accountsChanged',a?[a]:[]);};
  w.setChain=c=>{w.chain=c;emit('chainChanged',c);};
  w.disconnect=()=>{w.account=null;emit('disconnect',{code:4900});};
  const forward=async(method,params=[])=>{
    const response=await fetch(config.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    const body=await response.json();if(body.error)throw body.error;return body.result;
  };
  window.__u05Wallet=w;
  Object.defineProperty(window,'ethereum',{configurable:true,value:{
    on(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);},
    removeListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(x=>x!==fn));},
    async request({method,params=[]}){
      if(method==='eth_accounts'||method==='eth_requestAccounts'){
        if(w.holdAccounts)await new Promise(()=>{});
        return w.account?[w.account]:[];
      }
      if(method==='eth_chainId')return w.chain;
      if(method==='wallet_switchEthereumChain'||method==='wallet_addEthereumChain'){w.setChain('0x4f25');return null;}
      if(method==='eth_sendTransaction'){
        if(w.mode==='reject')throw {code:4001,message:'Injected local rejection'};
        const hash=await forward(method,params);w.lastHash=hash;
        await window.__recordU05Send({transaction:params[0],hash});
        if(w.mode==='unknown')throw new TypeError('Injected disconnect after actual Anvil broadcast');
        return hash;
      }
      return forward(method,params);
    }
  }});
}"""

def context_for(browser, account, width=390):
    context = browser.new_context(viewport={"width":width,"height":844 if width < 600 else 1000})
    context.expose_binding("__recordU05Send", lambda _source, value: sends.append(value))
    config={"account":account,"rpcUrl":cfg["rpcUrl"]}
    context.add_init_script("("+provider_script+")("+json.dumps(config)+")")
    return context

def open_student(context):
    page=context.new_page()
    page.on("pageerror",lambda error:errors.append(str(error)))
    page.goto(args.origin+"/student")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_test_id("grant-balance")).to_be_visible(timeout=20000)
    return page

def balance(page, value):
    expect(page.get_by_test_id("grant-balance")).to_have_text(value+" CAMPUS",timeout=20000)

def spend(page):
    page.get_by_role("button",name="Chi FOOD bằng Core",exact=True).click()

def read_again(page):
    page.get_by_role("button",name="Đọc lại / Tra receipt",exact=True).click()

def screenshot(page, name):
    # Add a visible environment label after hydration; never change the React body tree.
    page.add_style_tag(content="body::before{content:'KIỂM THỬ EVM LOCAL · Ví EIP-1193 giả lập · Không phải Core hoặc Avalanche L1 thật';display:block;background:#713c12;color:white;padding:8px 12px;font:12px/1.5 system-ui;text-align:center}")
    # Full-page capture can paint a fixed offscreen skip-link at the old scroll Y.
    # Start at the document top so the image matches what the user can actually see.
    page.evaluate("window.scrollTo(0,0);document.activeElement?.blur()")
    page.wait_for_function("scrollY===0")
    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), "Horizontal page overflow"
    page.screenshot(path=str(args.output/(name+".png")),full_page=True)

assert int(rpc("eth_chainId"),16)==20261
assert "anvil" in rpc("web3_clientVersion").lower()
canonical_path=Path(__file__).resolve().parents[2]/"deployments/intracampus.json"
assert hashlib.sha256(canonical_path.read_bytes()).hexdigest()==provenance["canonicalManifestSha256"]

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel="msedge")
    context=context_for(browser,cfg["beneficiary"])
    page=open_student(context)
    balance(page,"5.000")
    screenshot(page,"student-grant-before-mobile")
    page.locator("#grant-amount").fill("5001")
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    page.locator("#grant-amount").fill("1e3")
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    page.locator("#grant-amount").fill("1000")
    passed("Real Student reads 5000 through Next proxy/B05; overbalance and exponent inputs blocked")

    page.evaluate("a=>window.__u05Wallet.setAccount(a)",cfg["normalAccount"])
    balance(page,"0")
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    page.evaluate("a=>{window.__u05Wallet.setAccount(a[0]);window.__u05Wallet.setAccount(a[1]);}",[cfg["normalAccount"],cfg["beneficiary"]])
    balance(page,"5.000")
    expect(page.locator(".wallet-address")).to_have_text(cfg["beneficiary"].lower())
    passed("Zero balance is verified zero; rapid account changes finish on the current beneficiary")

    page.evaluate("window.__u05Wallet.setChain('0xa869')")
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    screenshot(page,"student-wrong-chain")
    page.evaluate("window.__u05Wallet.setChain('0x4f25')")
    balance(page,"5.000")
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_enabled(timeout=15000)
    passed("Wrong wallet chain blocks spending; correct chain restores readiness")

    page.route("**/api/grants/**",lambda route:route.fulfill(status=503,content_type="application/json",body=json.dumps({"status":"unverified","chainId":20261,"balanceWei":None,"error":{"code":"RPC_UNAVAILABLE","retryable":True}})))
    read_again(page)
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    expect(page.get_by_text(re.compile("Số dư đã xác minh gần nhất"))).to_be_visible()
    screenshot(page,"student-rpc-error")
    page.unroute("**/api/grants/**")
    read_again(page)
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_enabled(timeout=15000)
    passed("Injected API/RPC error marks balance stale and blocks spend; retry reads actual B05 again")

    before_sends=len(sends)
    page.evaluate("window.__u05Wallet.mode='reject'")
    spend(page)
    expect(page.get_by_text(re.compile("Bạn đã từ chối ký"))).to_be_visible(timeout=15000)
    assert len(sends)==before_sends
    assert lookup(cfg["beneficiary"])["balanceWei"]=="5000000000000000000000"
    screenshot(page,"student-rejected")
    page.evaluate("window.__u05Wallet.mode='normal'")
    # Grant refresh clears the rejected message/stale marker before an explicit retry.
    read_again(page)
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_enabled(timeout=15000)
    passed("Rejected wallet request broadcasts nothing and preserves 5000 grant")

    merchant_before=int(rpc("eth_getBalance",[cfg["canteen"],"latest"]),16)
    rpc("evm_setAutomine",[False])
    spend(page)
    expect(page.get_by_text(re.compile("Đã có hash, đang chờ receipt"))).to_be_visible(timeout=15000)
    assert len(sends)==before_sends+1
    tx=sends[-1]
    assert tx["transaction"]["value"]=="0x0"
    screenshot(page,"student-pending-mobile")
    page.reload();page.wait_for_load_state("networkidle")
    expect(page.get_by_text(re.compile("Đã có hash, đang chờ receipt"))).to_be_visible(timeout=15000)
    assert len(sends)==before_sends+1
    rpc("evm_mine");rpc("evm_setAutomine",[True])
    balance(page,"4.000")
    expect(page.get_by_text("Đã xác minh khoản chi FOOD. Số dư hiển thị đã đọc lại từ chain.",exact=True)).to_be_visible(timeout=15000)
    receipt=lookup(cfg["beneficiary"],tx["hash"])
    assert receipt["transaction"]["status"]=="verified"
    assert receipt["transaction"]["events"][0]["amountWei"]=="1000000000000000000000"
    assert int(rpc("eth_getBalance",[cfg["canteen"],"latest"]),16)-merchant_before==1000*10**18
    screenshot(page,"student-grant-after-mobile")
    page.set_viewport_size({"width":1440,"height":1000})
    screenshot(page,"student-grant-after-desktop")
    page.reload();page.wait_for_load_state("networkidle");balance(page,"4.000")
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    assert len(sends)==before_sends+1
    passed("Actual spend value0: 5000 to 4000, canteen +1000; pending/confirmed reload does not resend",receipt=receipt)
    context.close()

    # The controller harness already used this distinct student once (5000 -> 4000).
    prepared_account=cfg["preparedBeneficiary"]
    context=context_for(browser,prepared_account)
    first=open_student(context);balance(first,"4.000")
    count=len(sends)
    first.evaluate("window.__u05Wallet.holdAccounts=true")
    spend(first)
    first.wait_for_function("Object.keys(localStorage).some(k=>k.startsWith('intracampus.grant.spend.')&&JSON.parse(localStorage.getItem(k)).phase==='prepared')")
    second=open_student(context);balance(second,"4.000")
    second.get_by_role("button",name="Khôi phục lượt chưa gửi",exact=True).click()
    expect(second.get_by_role("alert").filter(has_text="Khoản chi trước đang chờ")).to_be_visible(timeout=15000)
    assert second.evaluate("Object.keys(localStorage).some(k=>k.startsWith('intracampus.grant.spend.')&&JSON.parse(localStorage.getItem(k)).phase==='prepared')")
    assert len(sends)==count
    first.close()
    second.get_by_role("button",name="Khôi phục lượt chưa gửi",exact=True).click()
    expect(second.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_enabled(timeout=15000)
    assert len(sends)==count
    screenshot(second,"student-prepared-reconciled")
    spend(second);balance(second,"3.000")
    assert len(sends)==count+1
    passed("Actual Web Lock blocks other-tab recovery; closing old tab permits prepared reconciliation without sending")
    context.close()

    context=context_for(browser,cfg["beneficiary"])
    page=open_student(context);balance(page,"4.000")
    count=len(sends)
    page.evaluate("window.__u05Wallet.mode='unknown'")
    rpc("evm_setAutomine",[False])
    spend(page)
    expect(page.locator("#grant-recovery-hash")).to_be_visible(timeout=15000)
    assert len(sends)==count+1
    lost_hash=sends[-1]["hash"]
    page.reload();page.wait_for_load_state("networkidle")
    expect(page.locator("#grant-recovery-hash")).to_be_visible(timeout=15000)
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    assert len(sends)==count+1
    rpc("evm_mine");rpc("evm_setAutomine",[True])
    read_again(page);balance(page,"3.000")
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    screenshot(page,"student-unknown-remains-blocked")
    page.locator("#grant-recovery-hash").fill(lost_hash)
    page.get_by_role("button",name="Đối chiếu hash đã gửi",exact=True).click()
    expect(page.get_by_text("Đã xác minh khoản chi FOOD. Số dư hiển thị đã đọc lại từ chain.",exact=True)).to_be_visible(timeout=15000)
    assert len(sends)==count+1
    passed("Unknown after real broadcast stays blocked through reload and changed balance; exact hash reconciles without resend",transactionHash=lost_hash)

    page.get_by_role("button",name="Xem lại số dư để tạo khoản chi mới",exact=True).click()
    allow_tx=rpc("eth_sendTransaction",[{"from":cfg["admin"],"to":cfg["registry"],"data":cfg["disableCanteen"]}])
    assert rpc("eth_getTransactionReceipt",[allow_tx])["status"]=="0x1"
    read_again(page)
    expect(page.get_by_text("Căn-tin đã bị tắt quyền nhận FOOD",exact=True)).to_be_visible(timeout=15000)
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    assert lookup(cfg["beneficiary"])["balanceWei"]=="3000000000000000000000"
    assert len(sends)==count+1
    screenshot(page,"student-merchant-revoked")
    rpc("eth_sendTransaction",[{"from":cfg["admin"],"to":cfg["registry"],"data":cfg["enableCanteen"]}])
    passed("Actual registry revocation disables spending and preserves remaining grant")
    page.evaluate("window.__u05Wallet.disconnect()")
    expect(page.locator(".wallet-address")).to_have_count(0)
    expect(page.get_by_role("button",name="Chi FOOD bằng Core",exact=True)).to_be_disabled()
    passed("Disconnect clears wallet identity and disables new spending")
    context.close();browser.close()

assert errors==[],errors
assert hashlib.sha256(canonical_path.read_bytes()).hexdigest()==provenance["canonicalManifestSha256"]
report={"environment":"local-anvil","scope":"Actual current Student UI and B05 API with actual contract receipts; injected EIP-1193 adapter, one injected HTTP error; not Core/physical-device/Avalanche L1 acceptance", "provenance":provenance,"cases":cases,"sends":sends,"errors":errors}
(args.output/"browser-report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps({"passed":len(cases),"actualBroadcasts":len(sends),"errors":errors}))
