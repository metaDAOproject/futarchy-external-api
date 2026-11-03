import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from './helpers/testApp.js';
import { openApiSpec } from '../src/openapi.js';

// Drift guard for src/openapi.ts: the spec must be internally consistent and
// every documented operation must be served by the app.

type Json = unknown;

const spec = openApiSpec as unknown as {
  openapi: string;
  paths: Record<string, {
    servers?: Array<{ url: string }>;
  } & Record<string, {
    operationId?: string;
    parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
  }>>;
  components: Record<string, Record<string, unknown>>;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

/** Valid sample values for path and required query parameters. */
const SAMPLES: Record<string, string> = {
  mintAddress: 'So11111111111111111111111111111111111111112',
  id: 'So11111111111111111111111111111111111111112',
  startDate: '2026-01-01',
  endDate: '2026-01-02',
  fromBlock: '1000',
  toBlock: '2000',
};


function collectRefs(node: Json, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

function resolveRef(ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = spec;
  for (const segment of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

function resolveParam(param: { $ref?: string; name?: string; in?: string; required?: boolean }) {
  return (param.$ref ? resolveRef(param.$ref) : param) as { name: string; in: string; required?: boolean };
}

function operations() {
  const ops: Array<{ key: string; method: string; url: string }> = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = (op.parameters ?? []).map(resolveParam);
      let url = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        const sample = SAMPLES[name];
        if (!sample) throw new Error(`No sample for path parameter '${name}' in ${path}`);
        return encodeURIComponent(sample);
      });
      const query = params
        .filter(p => p.in === 'query' && p.required)
        .map(p => {
          const sample = SAMPLES[p.name];
          if (!sample) throw new Error(`No sample for required query parameter '${p.name}' in ${path}`);
          return `${encodeURIComponent(p.name)}=${encodeURIComponent(sample)}`;
        });
      if (query.length > 0) url += `?${query.join('&')}`;
      // Each documented server prefix (e.g. /v1 and / for data endpoints) must serve it.
      const prefixes = (item.servers ?? [{ url: '/' }]).map((s) => s.url.replace(/\/$/, ''));
      for (const prefix of prefixes) {
        ops.push({ key: `${method.toUpperCase()} ${prefix}${path}`, method, url: prefix + url });
      }
    }
  }
  return ops;
}

describe('OpenAPI spec', () => {
  it('is a structurally valid OpenAPI 3.1 document', () => {
    expect(spec.openapi).toBe('3.1.0');

    const unresolved = collectRefs(spec).filter(ref => resolveRef(ref) === undefined);
    expect(unresolved).toEqual([]);

    const operationIds = Object.values(spec.paths)
      .flatMap(item => HTTP_METHODS.map(m => item[m]?.operationId))
      .filter(Boolean);
    expect(operationIds.length).toBeGreaterThan(0);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('documents only routes the app actually serves', async () => {
    const app = createTestApp();
    const missing: string[] = [];

    for (const op of operations()) {
      const response = await (request(app) as unknown as Record<string, (url: string) => request.Test>)[op.method]!(op.url);
      if (response.status === 404 && response.body?.code === 'NOT_FOUND') {
        missing.push(`${op.key} (requested ${op.url})`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('serves /openapi.json (this spec) and /docs', async () => {
    const app = createTestApp();

    const specResponse = await request(app).get('/openapi.json');
    expect(specResponse.status).toBe(200);
    expect(specResponse.headers['content-type']).toContain('application/json');
    expect(specResponse.body).toEqual(JSON.parse(JSON.stringify(openApiSpec)));

    const docsResponse = await request(app).get('/docs');
    expect(docsResponse.status).toBe(200);
    expect(docsResponse.headers['content-type']).toContain('text/html');
  });
});
