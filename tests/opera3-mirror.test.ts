import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRouter } from '../src/router.js';
import type { AppContext } from '../src/app-context.js';

function makeCtx(): AppContext {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  return {
    appId: 'bank-reconcile',
    tenantId: 't1',
    config: {},
    operaType: 'opera-3',
    db: {
      sam: {} as any,
      app: null,
      operaSystem: null,
      getCompanyDb: () => null,
    },
    logger,
  };
}

let server: http.Server;
let port: number;

const TEST_COMPANY = 'C';

beforeAll(async () => {
  const app = express();
  // SAM's middleware (`packages/backend/src/middleware/company.ts`)
  // reads the `X-Opera-Company` header and stamps `req.operaCompany`
  // before plugin routes run. Stub the same field here so per-company
  // routes don't 400 out on the way to the handler we're actually
  // testing (the opera-3 mirror).
  app.use((req, _res, next) => {
    req.operaCompany = TEST_COMPANY;
    next();
  });
  app.use(createRouter(makeCtx()));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: resp.statusCode ?? 0, body: JSON.parse(body) });
          } catch {
            resolve({ status: resp.statusCode ?? 0, body });
          }
        });
      })
      .on('error', reject);
  });
}

describe('opera3 mirror middleware', () => {
  it('canonical /api/bank-reconcile/status responds', async () => {
    const r = await get('/api/bank-reconcile/status');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.opera_type).toBe('opera-3');
  });

  it('mirror /api/opera3/bank-reconcile/status hits the same handler', async () => {
    const r = await get('/api/opera3/bank-reconcile/status');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.app).toBe('bank-reconcile');
  });

  it('mirror and canonical produce identical responses for list-csv', async () => {
    const r1 = await get('/api/bank-import/list-csv');
    const r2 = await get('/api/opera3/bank-import/list-csv');
    expect(r1.status).toBe(r2.status);
    expect(r1.body.success).toBe(r2.body.success);
  });

  it('non-opera3 paths still resolve normally', async () => {
    const r = await get('/api/bank-import/list-csv');
    expect(r.status).toBe(200);
    expect(typeof r.body.success).toBe('boolean');
  });
});
