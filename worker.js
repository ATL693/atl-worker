/* A T L DATA Worker (buy-v1)
   Secrets required in Cloudflare: VTUGATE_API_KEY, FIREBASE_SA (service account JSON) */

const PROJECT = "a-t-l-data";
const ADMIN_EMAIL = "lawanahmadt03@gmail.com";
const SERVICE_IDS = { mtn: 87, airtel: 159, glo: 157, "9mobile": 252 };
const AIRTIME_IDS = { mtn: 58, airtel: 312, glo: 243, "9mobile": 244 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
const VTUGATE_BASE = "https://api.vtugate.com";
const BILLSTACK_BASE = "https://api.billstack.co/v2";
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const FS = `https://firestore.googleapis.com/v1/${DOCS}`;
let gCache = { t: "", exp: 0 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname, m = request.method;
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (p === "/health") return json({ ok: true, message: "A T L DATA Worker is running", version: "buy-v1" });

      if (p === "/vtu/data-services" && m === "GET") {
        const r = await vtugateRaw(env, "/api/v1/fetchallservices", new URLSearchParams({ service_type: "data" }));
        return r.ok ? json(r.data, r.httpStatus) : json({ status: false, message: "Unable to fetch data services", error: r.error }, r.httpStatus || 502);
      }
      if (p === "/vtu/airtime-services" && m === "GET") {
        const r = await vtugateRaw(env, "/api/v1/fetchallservices", new URLSearchParams({ service_type: "airtime" }));
        return r.ok ? json(r.data, r.httpStatus) : json({ status: false, message: "Unable to fetch airtime services", error: r.error }, r.httpStatus || 502);
      }
      if (p.startsWith("/test-plans/") && m === "GET") {
        return await getPlans(env, decodeURIComponent(p.slice(12)).trim().toLowerCase());
      }
      if (p === "/vtu/data-plans" && m === "POST") {
        const b = await request.json().catch(() => null);
        if (!b) return json({ status: false, message: "Invalid JSON request" }, 400);
        let n = String(b.network || "").trim().toLowerCase();
        if (!n && b.service_id) n = Object.keys(SERVICE_IDS).find((k) => SERVICE_IDS[k] === Number(b.service_id)) || "";
        if (!n) return json({ status: false, message: "Network or service_id is required" }, 400);
        return await getPlans(env, n);
      }
      if (p === "/admin/vtu-balance" && m === "GET") {
        const tk = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
        const au = tk ? await verifyIdToken(tk).catch(() => null) : null;
        if (!au || au.email_verified !== true || String(au.email || "").toLowerCase() !== ADMIN_EMAIL) return json({ status: false, message: "Not allowed" }, 403);
        let sec2; try { sec2 = await fsGet(env, "config/security"); } catch { sec2 = null; }
        if (sec2 && sec2.ipWhitelist === true) {
          const allowed = String(sec2.ips || "").split(",").map((x) => x.trim()).filter(Boolean);
          const ip = request.headers.get("CF-Connecting-IP") || "";
          if (allowed.length && !allowed.includes(ip)) return json({ status: false, message: "Not allowed" }, 403);
        }
        const r = await vtugateRaw(env, "/api/v1/accountdetails", new URLSearchParams());
        const d = r.data && r.data.data;
        if (!r.ok || !d) return json({ status: false, message: "Unable to fetch VTUGate balance" }, r.httpStatus || 502);
        return json({ status: true, wallet_balance: Number(d.wallet_balance || 0), account_status: d.account_status || "" });
      }
      if (p === "/account/create" && m === "POST") return await createDepositAccount(request, env);
      if (p === "/webhooks/billstack" && m === "POST") return await billstackWebhook(request, env);
      if (p === "/buy-airtime" && m === "POST") return await buyAirtime(request, env);
      if (p === "/buy-data" && m === "POST") return await buyData(request, env);

      return json({ status: false, message: "Endpoint not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ status: false, message: "Server error. Please check your Transactions." }, 500);
    }
  }
};

/* ---------- PLANS (public price = VTUGate price + your data charge) ---------- */
async function getPlans(env, network) {
  const sid = SERVICE_IDS[network];
  if (!sid) return json({ status: false, message: "Unsupported network", supported_networks: Object.keys(SERVICE_IDS) }, 400);
  const r = await vtugateRaw(env, "/api/v1/fetchdataplans", new URLSearchParams({ service_id: String(sid) }));
  if (!r.ok) return json({ status: false, network, service_id: sid, plans: [], message: "VTUGATE request failed", error: r.error }, r.httpStatus || 502);
  const plans = r.data?.data?.data_plans;
  if (!Array.isArray(plans)) return json({ status: false, network, service_id: sid, plans: [], message: "VTUGATE returned no data_plans array" }, 502);
  let fee = 0;
  try { fee = Number((await fsGet(env, "config/charges"))?.data || 0); } catch {}
  return json({ status: r.data.status === true, network, service_id: sid, plans: plans.map((x) => ({ ...x, price: Math.ceil(Number(x.price) + fee) })) }, r.httpStatus);
}

/* ---------- BUY DATA ---------- */
async function buyData(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const u = token ? await verifyIdToken(token).catch(() => null) : null;
  if (!u || u.email_verified !== true) return json({ status: false, message: "Please login again." }, 401);

  const b = await request.json().catch(() => null);
  if (!b) return json({ status: false, message: "Invalid request." }, 400);
  const network = String(b.network || "").toLowerCase(), code = String(b.plan_code || ""), phone = String(b.phone || "").trim();
  if (!SERVICE_IDS[network] || !code || !/^0[789][01]\d{8}$/.test(phone)) return json({ status: false, message: "Invalid network, plan or phone number." }, 400);

  const [user, services, charges, discounts, general] = await Promise.all(
    ["users/" + u.sub, "config/services", "config/charges", "config/discounts", "config/general"].map((x) => fsGet(env, x))
  );
  if (!user) return json({ status: false, message: "Account not found." }, 404);
  if (user.isBlocked === true) return json({ status: false, message: "Your account is restricted. Please contact support." }, 403);
  if ((services || {}).data === false) return json({ status: false, message: "Data service is currently unavailable." }, 503);
  if ((general || {}).maintenance === true) return json({ status: false, message: "We are under maintenance. Please try again later." }, 503);

  const rl = await checkRateLimit(env, u.sub);
  if (!rl.ok) return json({ status: false, message: rl.message }, 429);

  // Price is always taken from VTUGate here, never from the browser.
  const pr = await vtugateRaw(env, "/api/v1/fetchdataplans", new URLSearchParams({ service_id: String(SERVICE_IDS[network]) }));
  const plan = pr.ok && pr.data?.data?.data_plans?.find((x) => String(x.code) === code);
  if (!plan) return json({ status: false, message: "Plan not available. Please reload plans." }, 400);

  const cost = Number(plan.price), fee = Number((charges || {}).data || 0), disc = Number((discounts || {})[user.tier || "basic"] || 0);
  let sell = Math.ceil((cost + fee) * (1 - disc / 100));
  if (sell < cost) sell = Math.ceil(cost);

  // 1) Take the money first, and create the transaction record in the same atomic commit.
  const txId = crypto.randomUUID().replace(/-/g, "").slice(0, 20), txPath = "transactions/" + txId;
  const held = await changeBalance(env, u.sub, -sell, [create(txPath, {
    uid: u.sub, type: "Data", amount: sell, cost, profit: sell - cost, status: "processing",
    description: plan.name + " to " + phone, network, phone, planCode: code
  })]);
  if (!held.ok) return json({ status: false, message: held.message }, held.code);

  // 2) Call VTUGate.
  let outcome = "pending", res = null;
  try {
    const r = await vtugateRaw(env, "/api/v1/buydata", new URLSearchParams({
      service_id: String(plan.service_id), phone_number: phone, amount: String(cost), plan_code: code
    }));
    res = r.data;
    if (res && res.status === true && res.data && res.data.provider_status === true) outcome = "success";
    else if (res && res.status === false && r.httpStatus < 500) outcome = "failed";
  } catch (e) { console.error(e); }

  // 3) Finish. Refund ONLY on a clear failure; anything unclear stays "pending" for you to check.
  const ref = String(res?.data?.external_reference || ""), vid = String(res?.data?.transaction_id || "");
  if (outcome === "success") {
    await commitWrites(env, [upd(txPath, { status: "success", providerRef: ref, providerTxId: vid })]);
    return json({ status: true, message: "Data purchase successful.", new_balance: held.after, transaction_id: txId });
  }
  if (outcome === "failed") {
    await changeBalance(env, u.sub, sell, [upd(txPath, { status: "failed", providerMessage: String(res?.message || "").slice(0, 200) })]);
    return json({ status: false, message: (res && res.message ? res.message + ". " : "") + "Your money has been returned." }, 400);
  }
  await commitWrites(env, [upd(txPath, { status: "pending", providerRef: ref, providerTxId: vid })]);
  return json({ status: true, pending: true, message: "Your purchase is processing. Please check Transactions shortly.", new_balance: held.after }, 202);
}

/* ---------- BUY AIRTIME ---------- */
async function buyAirtime(request, env) {
  const tk = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const u = tk ? await verifyIdToken(tk).catch(() => null) : null;
  if (!u || u.email_verified !== true) return json({ status: false, message: "Please login again." }, 401);
  const b = await request.json().catch(() => null);
  if (!b) return json({ status: false, message: "Invalid request." }, 400);
  const network = String(b.network || "").toLowerCase(), phone = String(b.phone || "").trim(), amount = Number(b.amount);
  if (!AIRTIME_IDS[network] || !/^0[789][01]\d{8}$/.test(phone) || !Number.isInteger(amount) || amount < 50 || amount > 50000)
    return json({ status: false, message: "Invalid network, phone number or amount (50 to 50,000)." }, 400);

  const [user, services, charges, general] = await Promise.all(
    ["users/" + u.sub, "config/services", "config/charges", "config/general"].map((x) => fsGet(env, x))
  );
  if (!user) return json({ status: false, message: "Account not found." }, 404);
  if (user.isBlocked === true) return json({ status: false, message: "Your account is restricted. Please contact support." }, 403);
  if ((services || {}).airtime === false) return json({ status: false, message: "Airtime service is currently unavailable." }, 503);
  if ((general || {}).maintenance === true) return json({ status: false, message: "We are under maintenance. Please try again later." }, 503);

  const rl = await checkRateLimit(env, u.sub);
  if (!rl.ok) return json({ status: false, message: rl.message }, 429);

  const fee = Math.ceil(Number((charges || {}).airtime || 0)), sell = amount + fee;
  const txId = crypto.randomUUID().replace(/-/g, "").slice(0, 20), txPath = "transactions/" + txId;
  const held = await changeBalance(env, u.sub, -sell, [create(txPath, {
    uid: u.sub, type: "Airtime", amount: sell, cost: amount, profit: fee, status: "processing",
    description: network.toUpperCase() + " airtime " + amount + " to " + phone, network, phone
  })]);
  if (!held.ok) return json({ status: false, message: held.message }, held.code);

  let r = null;
  try {
    r = await vtugateRaw(env, "/api/v1/buyairtime", new URLSearchParams({ service_id: String(AIRTIME_IDS[network]), phone_number: phone, amount: String(amount) }));
  } catch (e) { console.error(e); }
  return await settle(env, u.sub, txPath, sell, held, r, "Airtime purchase");
}

// Same rules as data: refund ONLY on a clear failure; anything unclear stays "pending".
async function settle(env, uid, txPath, sell, held, r, label) {
  const res = r && r.data;
  let outcome = "pending";
  if (res && res.status === true && res.data && res.data.provider_status === true) outcome = "success";
  else if (res && res.status === false && r.httpStatus < 500) outcome = "failed";
  const ref = String(res?.data?.external_reference || ""), vid = String(res?.data?.transaction_id || "");
  if (outcome === "success") {
    await commitWrites(env, [upd(txPath, { status: "success", providerRef: ref, providerTxId: vid })]);
    return json({ status: true, message: label + " successful.", new_balance: held.after, transaction_id: txPath.slice(13) });
  }
  if (outcome === "failed") {
    await changeBalance(env, uid, sell, [upd(txPath, { status: "failed", providerMessage: String(res?.message || "").slice(0, 200) })]);
    return json({ status: false, message: (res && res.message ? res.message + ". " : "") + "Your money has been returned." }, 400);
  }
  await commitWrites(env, [upd(txPath, { status: "pending", providerRef: ref, providerTxId: vid })]);
  return json({ status: true, pending: true, message: "Your purchase is processing. Please check Transactions shortly.", new_balance: held.after }, 202);
}

/* ---------- DEPOSIT ACCOUNT (BillStack reserved virtual account) ---------- */
async function createDepositAccount(request, env) {
  const tk = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const u = tk ? await verifyIdToken(tk).catch(() => null) : null;
  if (!u || u.email_verified !== true) return json({ status: false, message: "Please login again." }, 401);

  const user = await fsGet(env, "users/" + u.sub);
  if (!user) return json({ status: false, message: "Account not found." }, 404);

  // Already has one - just return it (idempotent).
  if (user.baAccountNumber) {
    return json({ status: true, message: "Account already exists.", data: {
      account_number: user.baAccountNumber, account_name: user.baAccountName, bank_name: user.baBankName
    }});
  }
  const bsKey = await getBillstackKey(env);
  if (!bsKey) return json({ status: false, message: "Deposit service is not configured yet." }, 500);

  const name = String(user.name || "Customer User").trim().split(/\s+/);
  const firstName = name[0] || "Customer", lastName = name.slice(1).join(" ") || "User";
  const phone = String(user.phone || "08000000000").replace(/\D/g, "").slice(0, 11) || "08000000000";

  let r;
  try {
    r = await fetch(BILLSTACK_BASE + "/thirdparty/generateVirtualAccount/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + bsKey },
      body: JSON.stringify({ reference: u.sub, email: user.email || "", phone, firstName, lastName, bank: "9PSB" })
    });
  } catch (e) {
    return json({ status: false, message: "Could not reach the deposit provider. Please try again." }, 502);
  }
  const d = await r.json().catch(() => null);
  const acc = d && d.status && d.data && d.data.account && d.data.account[0];
  if (!acc) return json({ status: false, message: (d && d.message) || "Could not create your deposit account." }, r.status || 502);

  await commitWrites(env, [upd("users/" + u.sub, {
    baAccountNumber: acc.account_number, baAccountName: acc.account_name, baBankName: acc.bank_name, baBankId: acc.bank_id || "9PSB"
  })]);
  return json({ status: true, message: "Account created.", data: { account_number: acc.account_number, account_name: acc.account_name, bank_name: acc.bank_name } });
}

async function billstackWebhook(request, env) {
  const raw = await request.text();
  const ts = request.headers.get("x-wiaxy-timestamp") || "";
  const sig = request.headers.get("x-wiaxy-signature-256") || "";
  const whKey = await getBillstackKey(env);
  if (!whKey || !ts || !sig) return json({ status: false, message: "Rejected." }, 401);
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ status: false, message: "Stale event." }, 401);

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(whKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts + "." + raw));
  const expected = [...new Uint8Array(macBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== sig.length || expected !== sig.toLowerCase()) return json({ status: false, message: "Invalid signature." }, 401);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ status: true, message: "successful" }); }
  if (body.event !== "PAYMENT_NOTIFICATION") return json({ status: true, message: "successful" });

  const d = body.data || {};
  const uid = String(d.reference || d.merchant_reference || "");
  const amount = Math.floor(Number(d.amount || 0));
  const ref = String(d.transaction_ref || d.wiaxy_ref || "");
  if (!uid || !(amount > 0) || !ref) return json({ status: true, message: "successful" });

  const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60) || crypto.randomUUID();
  const txPath = "transactions/billstack_" + safeRef;

  const existing = await fsGet(env, txPath).catch(() => undefined);
  if (existing) return json({ status: true, message: "successful" }); // already credited, ack without double-crediting

  const held = await changeBalance(env, uid, amount, [create(txPath, {
    uid, type: "Deposit", amount, status: "success", description: "Automatic deposit via BillStack",
    providerRef: ref, payerName: (d.payer && ((d.payer.first_name || "") + " " + (d.payer.last_name || ""))) || ""
  })]);
  if (!held.ok) {
    console.error("BillStack credit failed:", held.message);
    return json({ status: false, message: "Could not credit account." }, 500); // let BillStack retry
  }
  return json({ status: true, message: "successful" });
}

/* ---------- FIRESTORE (REST, service account) ---------- */
const create = (p, o) => ({ update: { name: DOCS + "/" + p, fields: toFS(o) }, updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } });
const upd = (p, o) => ({ update: { name: DOCS + "/" + p, fields: toFS(o) }, updateMask: { fieldPaths: Object.keys(o) }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: true } });

function toFS(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k,
    typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
    : typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) }]));
}
function fromFS(f) {
  return Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k,
    "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue
    : "booleanValue" in v ? v.booleanValue : "stringValue" in v ? v.stringValue : null]));
}
async function fsPost(env, path, body) {
  const r = await fetch(FS + path, { method: "POST", headers: { Authorization: "Bearer " + (await gToken(env)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}
async function fsGet(env, path) {
  const r = await fetch(FS + "/" + path, { headers: { Authorization: "Bearer " + (await gToken(env)) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore " + r.status);
  return fromFS((await r.json()).fields);
}
async function commitWrites(env, writes) {
  const r = await fsPost(env, ":commit", { writes });
  if (!r.ok) throw new Error("Commit failed " + r.status);
}
// Atomic balance change (read + write in one Firestore transaction). Negative delta checks funds.
async function changeBalance(env, uid, delta, extra) {
  const upath = DOCS + "/users/" + uid;
  for (let i = 0; i < 3; i++) {
    const tx = (await fsPost(env, ":beginTransaction", {})).data.transaction;
    const g = await fsPost(env, ":batchGet", { documents: [upath], transaction: tx });
    const f = Array.isArray(g.data) && g.data[0] && g.data[0].found ? g.data[0].found.fields : null;
    if (!f) return { ok: false, code: 404, message: "Account not found." };
    const bal = f.balance ? Number(f.balance.integerValue ?? f.balance.doubleValue ?? 0) : 0, after = bal + delta;
    if (delta < 0 && after < 0) return { ok: false, code: 402, message: "Insufficient balance. Please fund your wallet." };
    const c = await fsPost(env, ":commit", {
      transaction: tx,
      writes: [{ update: { name: upath, fields: { balance: { doubleValue: after } } }, updateMask: { fieldPaths: ["balance"] }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: true } }, ...extra]
    });
    if (c.ok) return { ok: true, before: bal, after };
    if (c.status !== 409) return { ok: false, code: 500, message: "Could not process right now. Please try again." };
  }
  return { ok: false, code: 409, message: "System busy. Please try again." };
}

/* ---------- RATE LIMIT (per user, config/security.rateLimit purchases per minute) ---------- */
async function checkRateLimit(env, uid) {
  let sec;
  try { sec = await fsGet(env, "config/security"); } catch { sec = null; }
  const limit = Number((sec || {}).rateLimit || 0);
  if (!limit || limit <= 0) return { ok: true }; // not configured = no limit

  const path = DOCS + "/rateLimits/" + uid;
  for (let i = 0; i < 2; i++) {
    const tx = (await fsPost(env, ":beginTransaction", {})).data.transaction;
    const g = await fsPost(env, ":batchGet", { documents: [path], transaction: tx });
    const f = Array.isArray(g.data) && g.data[0] && g.data[0].found ? g.data[0].found.fields : null;
    const now = Date.now();
    const windowStart = f && f.windowStart ? Number(f.windowStart.integerValue || 0) : 0;
    const count = f && f.count ? Number(f.count.integerValue || 0) : 0;
    const fresh = now - windowStart > 60000;
    const nextCount = fresh ? 1 : count + 1;
    if (!fresh && count >= limit) {
      await fsPost(env, ":commit", { transaction: tx, writes: [] }); // release
      return { ok: false, message: "Too many purchases. Please wait a moment and try again." };
    }
    const c = await fsPost(env, ":commit", {
      transaction: tx,
      writes: [{ update: { name: path, fields: { windowStart: { integerValue: String(fresh ? now : windowStart) }, count: { integerValue: String(nextCount) } } }, updateTransforms: [] }]
    });
    if (c.ok) return { ok: true };
    if (c.status !== 409) return { ok: true }; // fail open on infra errors, never block a good sale
  }
  return { ok: true };
}

/* ---------- AUTH ---------- */
const b64u = (d) => { const a = typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d); let s = ""; a.forEach((x) => (s += String.fromCharCode(x))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function gToken(env) {
  if (gCache.t && gCache.exp > Date.now() + 60000) return gCache.t;
  const sa = JSON.parse(env.FIREBASE_SA), now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", unb64u(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: h + "." + p + "." + b64u(sig) }) });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google token error");
  gCache = { t: j.access_token, exp: Date.now() + 3500000 };
  return gCache.t;
}

async function verifyIdToken(token) {
  const [h, p, s] = token.split(".");
  const hd = JSON.parse(new TextDecoder().decode(unb64u(h))), pl = JSON.parse(new TextDecoder().decode(unb64u(p)));
  const keys = (await (await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com", { cf: { cacheTtl: 3600, cacheEverything: true } })).json()).keys;
  const jwk = keys.find((k) => k.kid === hd.kid);
  if (!jwk || hd.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), new TextEncoder().encode(h + "." + p));
  if (!ok || pl.aud !== PROJECT || pl.iss !== "https://securetoken.google.com/" + PROJECT || pl.exp < Date.now() / 1000 || !pl.sub) return null;
  return pl;
}

/* ---------- VTUGATE ---------- */
async function getVtuKey(env) {
  try { const k = await fsGet(env, "config/keys"); if (k && k.vtugateApiKey) return k.vtugateApiKey; } catch {}
  try { const s = await fsGet(env, "config/security"); if (s && s.vtugateApiKey) return s.vtugateApiKey; } catch {} // legacy location
  return env.VTUGATE_API_KEY || "";
}
async function getBillstackKey(env) {
  try { const k = await fsGet(env, "config/keys"); if (k && k.billstackApiKey) return k.billstackApiKey; } catch {}
  try { const s = await fsGet(env, "config/security"); if (s && s.billstackApiKey) return s.billstackApiKey; } catch {} // legacy location
  return env.BILLSTACK_SECRET_KEY || "";
}

async function vtugateRaw(env, endpoint, form) {
  const key = await getVtuKey(env);
  if (!key) return { ok: false, httpStatus: 500, error: "VTUGATE_API_KEY secret is missing" };
  try {
    const response = await fetch(VTUGATE_BASE + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer " + key },
      body: form.toString()
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, httpStatus: response.status, error: "Invalid JSON response from VTUGATE" }; }
    return { ok: response.ok, httpStatus: response.status, data };
  } catch (error) {
    return { ok: false, httpStatus: 502, error: error?.message || "Connection to VTUGATE failed" };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
}
