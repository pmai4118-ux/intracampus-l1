import express, { Router, type ErrorRequestHandler, type Request } from 'express';
import { LIBRARY_REQUEST_BODY_LIMIT_BYTES } from '@intracampus/network';
import type { AuthService } from '../auth/auth.service.ts';
import type { LibraryAuthConfig } from '../auth/auth.config.ts';
import type { LibraryService } from '../library/library.service.ts';
import { CanteenError } from './canteen.repository.ts';
import type { CanteenService } from './canteen.service.ts';
export function createCanteenRouter(service?: CanteenService, auth?: AuthService, config?: LibraryAuthConfig, library?: LibraryService) {
  const router = Router();
  const account = (req: Request) => {
    if (!service || !auth || !config || !library) throw new CanteenError('CONFIGURATION_ERROR',503);
    const cookies = req.headers.cookie?.split(';').map(s => s.trim()).filter(s => s.startsWith(`${config.cookieName}=`));
    const session = cookies?.length === 1 ? auth.session(cookies[0].slice(config.cookieName.length+1)) : null;
    if (!session) throw new CanteenError('UNAUTHENTICATED',401);
    if (session.account.role !== 'STUDENT') throw new CanteenError('FORBIDDEN',403);
    return { wallet: session.account.wallet, role: 'STUDENT' as const };
  };
  router.use('/api/canteen', (_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  router.use('/api/canteen', express.json({ limit: LIBRARY_REQUEST_BODY_LIMIT_BYTES }));
  router.get('/api/canteen/menu', (_req,res,next) => { try {
    if (!service) throw new CanteenError('CONFIGURATION_ERROR',503);
    res.json({ dishes: service.repository.menu().filter(d => d.active) });
  } catch(e) { next(e); } });
  router.get('/api/canteen/staff/overview', async (_req,res,next) => { try {
    if (!service) throw new CanteenError('CONFIGURATION_ERROR',503);
    res.json(await service.staffOverview());
  } catch(e) { next(e); } });
  router.post('/api/canteen/staff/orders/:id/serve', (req,res,next) => { try {
    if (!service) throw new CanteenError('CONFIGURATION_ERROR',503);
    if (config && req.get('Origin') !== config.origin) throw new CanteenError('FORBIDDEN',403);
    if (!req.body || Object.keys(req.body).join(',') !== 'served' || typeof req.body.served !== 'boolean') {
      throw new CanteenError('INVALID_REQUEST');
    }
    const updated = service.repository.setServed(String(req.params.id), req.body.served);
    const { wallet, ...rest } = updated;
    res.json({ ...rest, payerHint: `${wallet.slice(0, 6)}…${wallet.slice(-4)}` });
  } catch(e) { next(e); } });
  router.post('/api/canteen/staff/dishes/:id/availability', (req,res,next) => { try {
    if (!service) throw new CanteenError('CONFIGURATION_ERROR',503);
    if (config && req.get('Origin') !== config.origin) throw new CanteenError('FORBIDDEN',403);
    if (!req.body || Object.keys(req.body).join(',') !== 'active' || typeof req.body.active !== 'boolean') {
      throw new CanteenError('INVALID_REQUEST');
    }
    res.json({ dish: service.repository.setDishActive(String(req.params.id), req.body.active) });
  } catch(e) { next(e); } });
  router.get('/api/canteen/orders', (req,res,next) => { try { res.json({ orders: service!.repository.list(account(req).wallet) }); } catch(e) { next(e); } });
  router.post('/api/canteen/orders', async (req,res,next) => { try {
    const actor = account(req);
    if (req.get('Origin') !== config!.origin) throw new CanteenError('FORBIDDEN',403);
    if ((await library!.accountStatus({ ...actor, wallet: actor.wallet as `0x${string}` })).held) throw new CanteenError('ACCOUNT_HELD',403);
    const b = req.body;
    if (!b || Object.keys(b).sort().join(',') !== 'idempotencyKey,items,method' || !['WALLET','FOOD'].includes(b.method)
      || typeof b.idempotencyKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.idempotencyKey) || !Array.isArray(b.items) || !b.items.length
      || b.items.some((item: {dishId?: unknown; quantity?: unknown}) => !item || Object.keys(item).sort().join(',') !== 'dishId,quantity'
        || typeof item.dishId !== 'string' || !Number.isSafeInteger(item.quantity) || Number(item.quantity) < 1)
      || new Set(b.items.map((item: {dishId: string}) => item.dishId)).size !== b.items.length) throw new CanteenError('INVALID_REQUEST');
    res.status(201).json(service!.repository.create(actor.wallet,b.idempotencyKey,b.method,b.items));
  } catch(e) { next(e); } });
  router.post('/api/canteen/orders/:id/:action', async (req,res,next) => { try {
    const actor = account(req);
    if (req.get('Origin') !== config!.origin) throw new CanteenError('FORBIDDEN',403);
    const order = service!.repository.get(String(req.params.id),actor.wallet);
    if (req.params.action === 'prepare') {
      if (!req.body || Object.keys(req.body).length) throw new CanteenError('INVALID_REQUEST');
      const reconciled = await service!.reconcileWallet(order);
      if (reconciled.status !== 'PAID' && reconciled.status !== 'EXPIRED'
        && (await library!.accountStatus({ ...actor, wallet: actor.wallet as `0x${string}` })).held) {
        throw new CanteenError('ACCOUNT_HELD',403);
      }
      res.json(await service!.prepare(reconciled));
    } else if (req.params.action === 'transactions') {
      if (!req.body || Object.keys(req.body).join(',') !== 'txHash' || typeof req.body.txHash !== 'string') throw new CanteenError('INVALID_REQUEST');
      res.json(await service!.track(order,req.body.txHash));
    } else throw new CanteenError('NOT_FOUND',404);
  } catch(e) { next(e); } });
  const failure: ErrorRequestHandler = (e,_req,res,next) => {
    if (!_req.path.startsWith('/api/canteen')) return next(e);
    const status = e instanceof CanteenError ? e.httpStatus : Number(e?.httpStatus ?? (e?.type === 'entity.too.large' ? 413 : e?.type === 'entity.parse.failed' ? 400 : 503));
    res.status(status).json({ error: { code: e instanceof CanteenError ? e.code : (e?.code ?? 'SERVICE_UNAVAILABLE'), retryable: status === 503 } });
  };
  router.use(failure); return router;
}
