/* 居酒屋レジ「あかり」— 端末連携（クラウド）の置き場所
   Cloudflare Workers ＋ Durable Objects（SQLite）で動く。お店ごとに自分の Cloudflare アカウントへ設置して使う。

   しくみ
   - お店のキー（店舗キー）ごとに Durable Object「AkariShop」が1つでき、そのお店のデータを持つ。
     キーを知らない人には別の空の箱しか作れないので、データは見えない。
   - 端末は WebSocket でつなぎっぱなしにする。操作は1件ずつ順番に処理されるので、同時に注文しても消えない。
   - 端末は「変わったテーブル・会計・設定」だけを送る（ops）。ここで反映して、全端末へ最新の状態を配る（state）。
   - 会計番号はここで振り直す（同じ日の中で連番）。
   - 使用量（保存量・今日のリクエスト・今日の書き込み行数）を数えて state に付ける。無料プランの上限の目安と比べて、アプリが警告を出す。

   保存の形（1件あたり最大2MBの制限に収まるよう分けている）
   - kv：core（品目・税・店舗情報などテーブルと会計以外すべて。tableOrder＝テーブルの並び）、tz（会計番号の日付に使う時差）、usage
   - tbl：テーブル1卓ごと
   - sale：会計1件ごと（dk＝会計日の YYYYMMDD）
   - dev：端末ごとの「処理済みの操作番号（ack）」と名前 */
import { DurableObject } from 'cloudflare:workers';

/* 無料プラン（Workers Free）の上限の目安。保存量は Durable Object 1つあたり1GB、1日の枠は日本時間9時（UTC 0時）に戻る */
const LIMITS = { db: 1e9, req: 100000, rw: 100000 };
const VERSION = 1;

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
});

async function sha256(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket でつないでください' }, 426);
      const key = url.searchParams.get('key') || '';
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) return json({ error: '店舗キーの形が正しくありません' }, 400);
      const id = env.SHOP.idFromName('shop:' + (await sha256(key)));
      return env.SHOP.get(id).fetch(req);
    }
    /* 接続テスト用：ブラウザで開くとこの JSON が出る */
    return json({ app: 'akari-cloud', ok: true, version: VERSION });
  },
};

/* テーブルの3方向のまとめ：srv＝今の置き場所の版、base＝端末が元にした版、cur＝端末が送ってきた版。
   注文の数と提供済みの数は「端末での増減」を今の版に足す。人数などは端末で変えたものだけ反映する。
   会計（空席に戻す）と同時にほかの端末から注文が入っていたら、その注文は消さずにテーブルを使用中のまま残す。 */
export function mergeTable(srv, base, cur) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(srv, base)) return cur;
  const out = { ...srv };
  ['name', 'open', 'guests', 'start'].forEach((f) => { if (!same(cur[f], base[f])) out[f] = cur[f]; });
  const bm = new Map((base.lines || []).map((l) => [l.key, l]));
  const cm = new Map((cur.lines || []).map((l) => [l.key, l]));
  const lines = (srv.lines || []).map((l) => ({ ...l }));
  const sm = new Map(lines.map((l) => [l.key, l]));
  new Set([...bm.keys(), ...cm.keys()]).forEach((k) => {
    const b = bm.get(k), c = cm.get(k);
    const dq = (c ? c.qty : 0) - (b ? b.qty : 0), ds = (c ? c.sv || 0 : 0) - (b ? b.sv || 0 : 0);
    let l = sm.get(k);
    if (!l) {
      if (c && dq > 0) { l = { ...c, qty: dq, sv: Math.max(0, Math.min(dq, ds)) }; lines.push(l); sm.set(k, l); }
      return;
    }
    if (c && b && c.wt !== b.wt) l.wt = c.wt;
    l.qty += dq; l.sv = Math.max(0, Math.min(l.qty, (l.sv || 0) + ds));
  });
  out.lines = lines.filter((l) => l.qty > 0);
  const bs = new Set((base.slog || []).map((e) => e.id)), cs = new Set((cur.slog || []).map((e) => e.id));
  const slog = (srv.slog || []).filter((e) => !(bs.has(e.id) && !cs.has(e.id)));
  (cur.slog || []).forEach((e) => { if (!bs.has(e.id) && !slog.some((x) => x.id === e.id)) slog.push(e); });
  out.slog = slog;
  out.stack = Array.isArray(cur.stack) ? cur.stack : [];
  if (base.open && !cur.open) {
    if (out.lines.length) { out.open = true; out.guests = srv.guests; out.start = srv.start; out.stack = []; out.slog = (srv.slog || []).filter((e) => !bs.has(e.id)); }
    else { out.slog = []; }
  }
  return out;
}

export class AkariShop extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS tbl (id TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sale (id TEXT PRIMARY KEY, dk TEXT NOT NULL, endt INTEGER NOT NULL, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS dev (id TEXT PRIMARY KEY, ack INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT \'\', seen INTEGER NOT NULL DEFAULT 0)');
    /* 生存確認の「ping」には、この箱を起こさずに「pong」と自動で返す（使用量を増やさない） */
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) { /* 古い環境 */ }
  }

  /* ---------- 小さな道具 ---------- */
  exec(q, ...a) { const c = this.sql.exec(q, ...a); this.rw += c.rowsWritten || 0; return c; }
  kvGet(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : null; }
  kvPut(k, v) { this.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }

  /* 使用量：今日（UTC）のリクエスト数と書き込み行数。WebSocket で届いたメッセージは20通で1リクエストとして数える（Cloudflare と同じ） */
  usageStart() { this.rw = 0; }
  usageEnd({ conn = 0, msg = 0 } = {}) {
    const day = new Date().toISOString().slice(0, 10);
    let u = this.kvGet('usage');
    if (!u || u.day !== day) u = { day, conn: 0, msg: 0, rw: 0 };
    u.conn += conn; u.msg += msg; u.rw += this.rw + 1; /* +1 は usage 自身の書き込み */
    this.sql.exec('INSERT INTO kv (k, v) VALUES (\'usage\', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', JSON.stringify(u));
    this.usage = u;
  }
  usageInfo() {
    const u = this.usage || this.kvGet('usage') || { day: '', conn: 0, msg: 0, rw: 0 };
    let db = 0; try { db = this.sql.databaseSize; } catch (e) { db = 0; }
    return { db, dbMax: LIMITS.db, req: u.conn + Math.ceil(u.msg / 20), reqMax: LIMITS.req, rw: u.rw, rwMax: LIMITS.rw, day: u.day };
  }

  dayKey(ts) {
    const tz = this.kvGet('tz') ?? 540; /* 分。日本は +540 */
    const d = new Date(ts + tz * 60000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /* ---------- 状態の読み書き ---------- */
  isEmpty() { return !this.sql.exec('SELECT 1 FROM kv WHERE k = \'core\'').toArray().length; }
  readState() {
    const core = this.kvGet('core') || {};
    const rows = this.sql.exec('SELECT id, v FROM tbl').toArray();
    const byId = new Map(rows.map((r) => [r.id, JSON.parse(r.v)]));
    const tables = [];
    (core.tableOrder || []).forEach((id) => { if (byId.has(id)) { tables.push(byId.get(id)); byId.delete(id); } });
    byId.forEach((t) => tables.push(t));
    const sales = this.sql.exec('SELECT v FROM sale ORDER BY endt, rowid').toArray().map((r) => JSON.parse(r.v));
    const { tableOrder, ...rest } = core;
    return { ...rest, tables, sales };
  }
  writeAll(D) {
    const { tables = [], sales = [], ...core } = D || {};
    core.tableOrder = tables.map((t) => t.id);
    this.exec('DELETE FROM tbl');
    this.exec('DELETE FROM sale');
    this.kvPut('core', core);
    tables.forEach((t) => { if (t && t.id) this.exec('INSERT OR REPLACE INTO tbl (id, v) VALUES (?, ?)', t.id, JSON.stringify(t)); });
    sales.forEach((x) => { if (x && x.id) this.exec('INSERT OR REPLACE INTO sale (id, dk, endt, v) VALUES (?, ?, ?, ?)', x.id, this.dayKey(x.end || Date.now()), x.end || Date.now(), JSON.stringify(x)); });
  }
  applyOps(m, devName) {
    if (m.core && typeof m.core === 'object') this.kvPut('core', m.core);
    (m.tdel || []).forEach((id) => this.exec('DELETE FROM tbl WHERE id = ?', String(id)));
    (m.tables || []).forEach((t) => {
      if (!t || !t.id || !Array.isArray(t.lines)) return;
      /* 端末が元にした版（tbase）と今の版が違う＝ほかの端末が先に変えていたら、行ごとに数を足し引きしてまとめる */
      const row = this.sql.exec('SELECT v FROM tbl WHERE id = ?', t.id).toArray()[0];
      const srv = row ? JSON.parse(row.v) : null, base = m.tbase && m.tbase[t.id];
      const v = srv && base ? mergeTable(srv, base, t) : t;
      this.exec('INSERT INTO tbl (id, v) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET v = excluded.v', t.id, JSON.stringify(v));
    });
    if (m.reset) this.exec('DELETE FROM sale');
    (m.sales || []).forEach((x) => {
      if (!x || !x.id || !Array.isArray(x.lines)) return;
      const row = this.sql.exec('SELECT v FROM sale WHERE id = ?', x.id).toArray()[0];
      if (row) {
        /* すでにある会計は「取り消し」だけを反映する */
        const cur = JSON.parse(row.v);
        if (x.voided && !cur.voided) {
          cur.voided = true; cur.voidedAt = x.voidedAt || Date.now();
          this.exec('UPDATE sale SET v = ? WHERE id = ?', JSON.stringify(cur), x.id);
        }
        return;
      }
      const end = x.end || Date.now(), dk = this.dayKey(end);
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM sale WHERE dk = ?', dk).toArray()[0].n;
      x.no = `${dk}-${String(n + 1).padStart(4, '0')}`;
      if (devName && !x.by) x.by = devName;
      this.exec('INSERT INTO sale (id, dk, endt, v) VALUES (?, ?, ?, ?)', x.id, dk, end, JSON.stringify(x));
    });
  }

  /* ---------- 端末への送信 ---------- */
  peers(skip) {
    const seen = new Set(), out = [];
    this.ctx.getWebSockets().forEach((ws) => {
      if (ws === skip) return;
      const a = ws.deserializeAttachment() || {};
      if (a.dev && !seen.has(a.dev)) { seen.add(a.dev); out.push({ dev: a.dev, name: a.name || '' }); }
    });
    return out;
  }
  ackOf(dev) { const r = this.sql.exec('SELECT ack FROM dev WHERE id = ?', dev).toArray()[0]; return r ? r.ack : 0; }
  stateMsg(skip) {
    const empty = this.isEmpty();
    return { t: 'state', empty, d: empty ? null : this.readState(), usage: this.usageInfo(), peers: this.peers(skip), v: VERSION };
  }
  send(ws, base) {
    const a = ws.deserializeAttachment() || {};
    try { ws.send(JSON.stringify({ ...base, ack: a.dev ? this.ackOf(a.dev) : 0 })); } catch (e) { /* 切れている */ }
  }
  broadcast() {
    const base = this.stateMsg();
    this.ctx.getWebSockets().forEach((ws) => this.send(ws, base));
  }

  /* ---------- WebSocket ---------- */
  async fetch(req) {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ dev: (url.searchParams.get('dev') || '').slice(0, 40), name: '' });
    this.usageStart(); this.usageEnd({ conn: 1 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    let m; try { m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch (e) { return; }
    const a = ws.deserializeAttachment() || {};
    this.usageStart();
    try {
      if (m.t === 'hello') {
        a.dev = String(m.dev || a.dev || '').slice(0, 40); a.name = String(m.name || '').slice(0, 16);
        ws.serializeAttachment(a);
        if (Number.isFinite(m.tz) && Math.abs(m.tz) <= 840) this.kvPut('tz', m.tz);
        if (a.dev) this.exec('INSERT INTO dev (id, name, seen) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, seen = excluded.seen', a.dev, a.name, Date.now());
        this.usageEnd({ msg: 1 });
        this.broadcast(); /* 新しくつながった端末に状態を送り、ほかの端末の一覧も更新する */
        return;
      }
      if (m.t === 'init') {
        /* 1台目の端末のデータで始める。すでにデータがあるときは force のときだけ置き換える */
        if (m.d && (this.isEmpty() || m.force)) this.writeAll(m.d);
        if (a.dev) this.exec('INSERT INTO dev (id, ack) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ack = MAX(ack, excluded.ack)', a.dev, +m.seq || 0);
        this.usageEnd({ msg: 1 });
        this.broadcast();
        return;
      }
      if (m.t === 'ops') {
        if (this.isEmpty()) { this.usageEnd({ msg: 1 }); this.send(ws, this.stateMsg()); return; }
        this.applyOps(m, a.name);
        if (a.dev) this.exec('INSERT INTO dev (id, ack) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ack = MAX(ack, excluded.ack)', a.dev, +m.seq || 0);
        this.usageEnd({ msg: 1 });
        this.broadcast();
        return;
      }
      if (m.t === 'erase') {
        /* 連携をやめるときに「クラウドのデータを消す」を選んだ場合 */
        this.exec('DELETE FROM tbl'); this.exec('DELETE FROM sale'); this.exec('DELETE FROM kv WHERE k = \'core\'');
        this.usageEnd({ msg: 1 });
        this.broadcast();
        return;
      }
      this.usageEnd({ msg: 1 });
    } catch (e) {
      try { ws.send(JSON.stringify({ t: 'error', message: String(e && e.message || e) })); } catch (_) { /* */ }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* */ }
    const base = this.stateMsg(ws);
    this.ctx.getWebSockets().filter((x) => x !== ws).forEach((x) => this.send(x, base));
  }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch (e) { /* */ } }
}
