import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CanteenDish, CanteenOrder, CanteenItem } from '@intracampus/network';

const unit = 10n ** 18n;
export const sampleDishes: CanteenDish[] = [
  { id: 'com-tam', name: 'Cơm tấm', description: 'Cơm tấm sườn nướng, đồ chua và rau.', priceWei: (18n * unit).toString(), active: true },
  { id: 'pho-bo', name: 'Phở bò', description: 'Phở bò với rau thơm.', priceWei: (22n * unit).toString(), active: true },
  { id: 'bun-bo', name: 'Bún bò', description: 'Bún bò và rau ăn kèm.', priceWei: (25n * unit).toString(), active: true },
];
export const demoDishes: CanteenDish[] = [
  ...sampleDishes,
  { id: 'com-ga-xoi-mo', name: 'Cơm gà xối mỡ', description: 'Đùi gà góc tư da giòn, cơm chiên hạt điều và canh rong biển.', priceWei: (22n * unit).toString(), active: true },
  { id: 'mi-quang-ga', name: 'Mì Quảng gà trứng', description: 'Mì Quảng gà ta, trứng cút, bánh đa nướng vừng và rau sống.', priceWei: (20n * unit).toString(), active: true },
  { id: 'banh-mi-cha-lua', name: 'Bánh mì chả lụa đặc biệt', description: 'Bánh mì giòn nóng, chả lụa, thịt nguội, pate gan và đồ chua.', priceWei: (12n * unit).toString(), active: true },
  { id: 'tra-dao-cam-sa', name: 'Trà đào cam sả', description: 'Hồng trà ủ lạnh kết hợp đào miếng giòn, cam vàng và sả tươi.', priceWei: (8n * unit).toString(), active: true },
  { id: 'ca-phe-sua-da', name: 'Cà phê sữa đá Sài Gòn', description: 'Cà phê phin truyền thống đậm vị pha cùng sữa đặc.', priceWei: (6n * unit).toString(), active: true },
  { id: 'sua-chua-trai-cay', name: 'Sữa chua trái cây hạt đác', description: 'Sữa chua nhà làm mát lạnh, xoài chín, dâu tây và hạt đác rim dứa.', priceWei: (9n * unit).toString(), active: true },
];
export class CanteenError extends Error {
  code: string; httpStatus: number;
  constructor(code: string, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
export class CanteenRepository {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS canteen_dishes(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS canteen_orders(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(wallet,idempotency_key)) STRICT;
      CREATE TABLE IF NOT EXISTS canteen_payment_claims(tx_hash TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS canteen_fulfillments(order_id TEXT PRIMARY KEY, served_at INTEGER NOT NULL) STRICT;`);
  }
  close() { this.db.close(); }
  seed(dishes: readonly CanteenDish[] = sampleDishes) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const dish of dishes) this.db.prepare('INSERT OR IGNORE INTO canteen_dishes VALUES (?,?)').run(dish.id, JSON.stringify(dish));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  syncCatalogPrices(dishes: readonly CanteenDish[] = demoDishes) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const dish of dishes) {
        const existing = this.db.prepare('SELECT data FROM canteen_dishes WHERE id=?').get(dish.id);
        if (!existing) {
          this.db.prepare('INSERT INTO canteen_dishes VALUES (?,?)').run(dish.id, JSON.stringify(dish));
        } else {
          const prev = JSON.parse(String(existing.data)) as CanteenDish;
          const merged: CanteenDish = { ...dish, active: prev.active };
          this.db.prepare('UPDATE canteen_dishes SET data=? WHERE id=?').run(JSON.stringify(merged), dish.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  menu(): CanteenDish[] { return this.db.prepare('SELECT data FROM canteen_dishes ORDER BY id').all().map(r => JSON.parse(String(r.data))); }
  get(id: string, wallet: string): CanteenOrder {
    const row = this.db.prepare('SELECT data FROM canteen_orders WHERE id=? AND wallet=?').get(id, wallet.toLowerCase());
    if (!row) throw new CanteenError('NOT_FOUND', 404);
    return JSON.parse(String(row.data));
  }
  list(wallet: string): CanteenOrder[] { return this.db.prepare('SELECT data FROM canteen_orders WHERE wallet=? ORDER BY rowid DESC').all(wallet.toLowerCase()).map(r => JSON.parse(String(r.data))); }
  create(wallet: string, key: string, method: CanteenOrder['method'], entries: { dishId: string; quantity: number }[]): CanteenOrder {
    wallet = wallet.toLowerCase();
    const normalized = [...entries].sort((a,b) => a.dishId.localeCompare(b.dishId));
    const fingerprint = JSON.stringify({ method, entries: normalized });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT fingerprint,data FROM canteen_orders WHERE wallet=? AND idempotency_key=?').get(wallet,key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CanteenError('IDEMPOTENCY_CONFLICT',409);
        this.db.exec('COMMIT'); return JSON.parse(String(previous.data));
      }
      const menu = this.menu();
      const items: CanteenItem[] = normalized.map(entry => {
        const dish = menu.find(d => d.id === entry.dishId && d.active);
        if (!dish) throw new CanteenError('DISH_UNAVAILABLE');
        return { dishId: dish.id, name: dish.name, unitPriceWei: dish.priceWei, quantity: entry.quantity };
      });
      const total = items.reduce((n,item) => n + BigInt(item.unitPriceWei) * BigInt(item.quantity),0n);
      if (total <= 0n || total >= 2n ** 256n) throw new CanteenError('INVALID_AMOUNT');
      const order: CanteenOrder = { id: randomUUID(), wallet, method, items, totalWei: total.toString(), status: 'AWAITING_PAYMENT', createdAt: Date.now(), afterBlock: null, invoiceId: null, txHash: null, paidAmountWei: null };
      this.db.prepare('INSERT INTO canteen_orders VALUES (?,?,?,?,?)').run(order.id,wallet,key,fingerprint,JSON.stringify(order));
      this.db.exec('COMMIT'); return order;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  // Conditional update prevents stale async lookups from overwriting a confirmed order.
  prepare(id: string, wallet: string, block: number, invoiceId: string | null) {
    const order = this.get(id,wallet);
    if (order.afterBlock !== null) return order;
    order.afterBlock = block; order.invoiceId = invoiceId;
    this.db.prepare("UPDATE canteen_orders SET data=? WHERE id=? AND json_extract(data,'$.afterBlock') IS NULL").run(JSON.stringify(order),id);
    return this.get(id,wallet);
  }
  expire(id: string, wallet: string) {
    const order = this.get(id,wallet);
    if (order.status === 'PAID' || order.txHash) return order;
    order.status = 'EXPIRED';
    this.db.prepare("UPDATE canteen_orders SET data=? WHERE id=? AND json_extract(data,'$.status')!='PAID' AND json_extract(data,'$.txHash') IS NULL").run(JSON.stringify(order),id);
    return this.get(id,wallet);
  }
  claim(id: string, wallet: string, hash: string) {
    const order = this.get(id,wallet);
    if (order.afterBlock === null) throw new CanteenError('PAYMENT_NOT_PREPARED',409);
    if (order.txHash && order.txHash !== hash) throw new CanteenError('PAYMENT_ALREADY_TRACKED',409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT order_id,tx_hash FROM canteen_payment_claims WHERE tx_hash=? OR order_id=?').get(hash,id);
      if (prior && (prior.order_id !== id || prior.tx_hash !== hash)) throw new CanteenError('PAYMENT_ALREADY_USED',409);
      this.db.prepare('INSERT OR IGNORE INTO canteen_payment_claims VALUES (?,?)').run(hash,id);
      order.txHash = hash;
      this.db.prepare("UPDATE canteen_orders SET data=? WHERE id=? AND json_extract(data,'$.status')!='PAID'").run(JSON.stringify(order),id);
      this.db.exec('COMMIT'); return this.get(id,wallet);
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  confirm(id: string, wallet: string, hash: string, paidAmountWei: string) {
    const order = this.claim(id,wallet,hash); order.status = 'PAID'; order.paidAmountWei = paidAmountWei;
    this.db.prepare("UPDATE canteen_orders SET data=? WHERE id=? AND json_extract(data,'$.status')!='PAID'").run(JSON.stringify(order),id);
    return this.get(id,wallet);
  }
  getById(id: string): CanteenOrder {
    const row = this.db.prepare('SELECT data FROM canteen_orders WHERE id=?').get(id);
    if (!row) throw new CanteenError('NOT_FOUND', 404);
    return JSON.parse(String(row.data));
  }
  listAllWithFulfillment(): Array<CanteenOrder & { servedAt: number | null }> {
    const rows = this.db.prepare(`
      SELECT o.data AS data, f.served_at AS served_at
      FROM canteen_orders o
      LEFT JOIN canteen_fulfillments f ON f.order_id = o.id
      ORDER BY o.rowid DESC
    `).all();
    return rows.map(r => ({
      ...(JSON.parse(String(r.data)) as CanteenOrder),
      servedAt: r.served_at === null || r.served_at === undefined ? null : Number(r.served_at),
    }));
  }
  setServed(id: string, served: boolean): CanteenOrder & { servedAt: number | null } {
    const order = this.getById(id);
    if (order.status !== 'PAID') throw new CanteenError('ORDER_NOT_PAID', 409);
    if (served) {
      const existing = this.db.prepare('SELECT served_at FROM canteen_fulfillments WHERE order_id=?').get(id);
      const servedAt = existing ? Number(existing.served_at) : Date.now();
      if (!existing) this.db.prepare('INSERT INTO canteen_fulfillments VALUES (?,?)').run(id, servedAt);
      return { ...order, servedAt };
    }
    this.db.prepare('DELETE FROM canteen_fulfillments WHERE order_id=?').run(id);
    return { ...order, servedAt: null };
  }
  setDishActive(dishId: string, active: boolean): CanteenDish {
    const row = this.db.prepare('SELECT data FROM canteen_dishes WHERE id=?').get(dishId);
    if (!row) throw new CanteenError('DISH_NOT_FOUND', 404);
    const dish: CanteenDish = { ...(JSON.parse(String(row.data)) as CanteenDish), active };
    this.db.prepare('UPDATE canteen_dishes SET data=? WHERE id=?').run(JSON.stringify(dish), dishId);
    return dish;
  }
}
