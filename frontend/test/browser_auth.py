"""Real challenge/session authentication for isolated Anvil browser fixtures."""
import json
from urllib.request import Request, ProxyHandler, build_opener


def signed_challenge(cfg, wallet, challenge):
    assert cfg["rpcUrl"].startswith("http://127.0.0.1:")
    request = Request(cfg["rpcUrl"], json.dumps({"jsonrpc": "2.0", "id": 1,
        "method": "eth_sign", "params": [wallet, "0x" + challenge["message"].encode().hex()]}).encode(),
        {"Content-Type": "application/json"})
    with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
        result = json.load(response)
    assert "error" not in result, "Fixture signing failed"
    return {"challengeId": challenge["challengeId"], "signature": result["result"]}


def authenticate(context, cfg, wallet, origin):
    """Keep actual HttpOnly cookies in the same browser context, never in evidence."""
    assert origin == cfg["origin"], "Browser origin must match fixture auth configuration"
    challenge = context.request.post(origin + "/api/auth/challenge", headers={"Origin": origin}, data={"wallet": wallet})
    assert challenge.status == 201
    verified = context.request.post(origin + "/api/auth/verify", headers={"Origin": origin},
        data=signed_challenge(cfg, wallet, challenge.json()))
    assert verified.status == 200


def authenticated_lookup(cfg, wallet, tx=None):
    http = build_opener(ProxyHandler({}))
    headers = {"Origin": cfg["origin"], "Content-Type": "application/json"}
    def post(path, body):
        with http.open(Request(cfg["api"] + path, json.dumps(body).encode(), headers), timeout=10) as response:
            return json.load(response), response.headers.get("Set-Cookie")
    challenge, _ = post("/api/auth/challenge", {"wallet": wallet})
    _, cookie = post("/api/auth/verify", signed_challenge(cfg, wallet, challenge))
    request = Request(cfg["api"] + "/api/grants/" + wallet + ("?txHash=" + tx if tx else ""),
        headers={"Cookie": cookie.split(";", 1)[0]})
    with http.open(request, timeout=10) as response:
        return json.load(response)
