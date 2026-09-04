/**
 * Architectural boundary tests.
 *
 * These assert properties that code review alone cannot keep true across time:
 * that the verification kernel never learns about Fastify, Drizzle or Razorpay;
 * that only one module can reach the payment provider; and that every reason
 * code in the vocabulary is actually used somewhere.
 *
 * They read source text rather than types, because the thing being protected is
 * a *dependency* property, and a type system will happily let you import
 * anything you like.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REASON_CODES } from '@capturelock/core';
import {
  AGENT_ACTION_KINDS,
  FORBIDDEN_TOOL_SUBSTRINGS,
  parseAgentAction,
} from '@capturelock/agent';

// Vitest runs from the workspace root, which is where the packages live.
const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  try {
    walk(absolute);
  } catch {
    return [];
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const matches = source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+'([^']+)'/g);
  return [...matches].map(match => match[1] ?? '');
}

describe('the kernel is provider- and framework-agnostic', () => {
  const files = sourceFiles('packages/kernel/src');

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(['fastify', 'drizzle', 'razorpay', 'pg', '@capturelock/integrations'])(
    'never imports %s',
    forbidden => {
      const offenders = files.filter(file =>
        importsOf(file).some(spec => spec === forbidden || spec.startsWith(`${forbidden}/`)),
      );
      expect(offenders.map(f => relative(ROOT, f))).toEqual([]);
    },
  );

  it('depends only on core, policy, evidence and Node built-ins', () => {
    const allowed = /^(node:|\.|@capturelock\/(core|policy|evidence)$|zod$)/;
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (!allowed.test(spec)) violations.push(`${relative(ROOT, file)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('the buyer agent cannot reach the money path', () => {
  const files = sourceFiles('packages/agent/src');

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('depends only on core, zod and Node built-ins', () => {
    // Deliberately narrower than the kernel's allowance: no kernel, no
    // persistence, no integrations. The agent runtime holds no repository and
    // no provider, so the strongest thing it can produce is a request.
    const allowed = /^(node:|\.|@capturelock\/core$|zod$)/;
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (!allowed.test(spec)) violations.push(`${relative(ROOT, file)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it.each([
    'fastify',
    'pg',
    'razorpay',
    '@capturelock/kernel',
    '@capturelock/persistence',
    '@capturelock/integrations',
  ])('never imports %s', forbidden => {
    const offenders = files.filter(file =>
      importsOf(file).some(spec => spec === forbidden || spec.startsWith(`${forbidden}/`)),
    );
    expect(offenders.map(f => relative(ROOT, f))).toEqual([]);
  });

  it('names no tool that could move money', () => {
    // The tool vocabulary is the boundary. If someone adds a provider-facing
    // tool to it, this fails and says which word gave it away.
    const offenders: string[] = [];
    for (const kind of AGENT_ACTION_KINDS) {
      for (const forbidden of FORBIDDEN_TOOL_SUBSTRINGS) {
        if (kind.toLowerCase().includes(forbidden))
          offenders.push(`${kind} contains "${forbidden}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exposes no action that carries an amount, a currency or a verdict', () => {
    // An agent cannot state a price it will be charged or a verdict it wants,
    // because the schemas are strict and have no such field. Asserted by
    // parsing, so the claim rests on the schema rather than on reading it.
    const attempts: unknown[] = [
      { action: 'ADD_ITEM', sku: 'SKU-A', quantity: 1, unitPrice: 1 },
      { action: 'ADD_ITEM', sku: 'SKU-A', quantity: 1, currency: 'INR' },
      { action: 'REQUEST_PURCHASE', reason: 'because', amount: 100 },
      { action: 'REQUEST_PURCHASE', reason: 'because', verdict: 'ALLOW' },
      { action: 'REQUEST_PURCHASE', reason: 'because', total: 79900 },
      { action: 'CAPTURE_PAYMENT', amount: 100 },
      { action: 'CHARGE_CARD', sku: 'SKU-A' },
    ];
    const accepted = attempts.filter(attempt => parseAgentAction(attempt).kind === 'PARSED');
    expect(accepted).toEqual([]);
  });
});

describe('core has no dependency on anything above it', () => {
  const files = sourceFiles('packages/core/src');

  it('imports only zod and Node built-ins', () => {
    const allowed = /^(node:|\.|zod$)/;
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (!allowed.test(spec)) violations.push(`${relative(ROOT, file)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('policy and evidence stay independent of each other', () => {
  it('policy does not import evidence or kernel', () => {
    const violations = sourceFiles('packages/policy/src').flatMap(file =>
      importsOf(file)
        .filter(spec => spec.includes('evidence') || spec.includes('kernel'))
        .map(spec => `${relative(ROOT, file)} -> ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it('evidence does not import policy or kernel', () => {
    const violations = sourceFiles('packages/evidence/src').flatMap(file =>
      importsOf(file)
        .filter(spec => spec.includes('policy') || spec.includes('kernel'))
        .map(spec => `${relative(ROOT, file)} -> ${spec}`),
    );
    expect(violations).toEqual([]);
  });
});

describe('the execution grant cannot be forged', () => {
  const grantSource = readFileSync(join(ROOT, 'packages/kernel/src/grant.ts'), 'utf8');

  it('keeps the brand symbol module-private', () => {
    // If this symbol were exported, any module could construct an
    // ExecutionGrant and call the provider without passing the kernel.
    expect(grantSource).toContain('declare const EXECUTION_GRANT: unique symbol;');
    expect(grantSource).not.toMatch(/export\s+(declare\s+)?const EXECUTION_GRANT/);
  });

  it('mints a grant only for an ALLOW verdict', () => {
    expect(grantSource).toContain("if (decision.verdict !== 'ALLOW') return null;");
  });

  it('exposes exactly one producer of grants', () => {
    const producers = [...grantSource.matchAll(/as ExecutionGrant/g)];
    expect(producers).toHaveLength(1);
  });
});

describe('nothing but the release path can reach a payment provider', () => {
  const routeFiles = [...sourceFiles('apps/api/src/routes'), join(ROOT, 'apps/api/src/server.ts')];

  it('no route module imports a payment adapter', () => {
    const offenders = routeFiles.filter(file =>
      importsOf(file).some(
        spec =>
          spec.includes('razorpay') || spec.endsWith('/fake.js') || spec.includes('FakePayment'),
      ),
    );
    expect(offenders.map(f => relative(ROOT, f))).toEqual([]);
  });

  it('no route module constructs a provider', () => {
    const offenders = routeFiles.filter(file => {
      const source = readFileSync(file, 'utf8');
      return /new\s+(RazorpayTestClient|FakePaymentProvider)\s*\(/.test(source);
    });
    expect(offenders.map(f => relative(ROOT, f))).toEqual([]);
  });

  it('the composition root is the only place a provider is constructed', () => {
    const constructors = [
      ...sourceFiles('apps/api/src'),
      ...sourceFiles('packages/kernel/src'),
    ].filter(file =>
      /new\s+(RazorpayTestClient|FakePaymentProvider)\s*\(/.test(readFileSync(file, 'utf8')),
    );

    expect(constructors.map(f => relative(ROOT, f))).toEqual(['apps/api/src/composition.ts']);
  });

  it('CoreDependencies carries no provider of any kind', () => {
    // A service built from CoreDependencies cannot call a provider because it
    // holds no reference to one. Structural, not a rule someone must remember.
    const source = readFileSync(join(ROOT, 'packages/kernel/src/services/dependencies.ts'), 'utf8');
    const coreBlock = source.slice(
      source.indexOf('export interface CoreDependencies'),
      source.indexOf('export interface ReconciliationDependencies'),
    );
    expect(coreBlock).not.toMatch(/payment/i);
  });

  it('reconciliation receives a read-only provider, so it cannot capture', () => {
    const source = readFileSync(join(ROOT, 'packages/kernel/src/services/dependencies.ts'), 'utf8');
    const reconBlock = source.slice(
      source.indexOf('export interface ReconciliationDependencies'),
      source.indexOf('export interface PaymentDependencies'),
    );
    expect(reconBlock).toContain('paymentReader: PaymentReader');
    expect(reconBlock).not.toContain('paymentExecutor');

    // Reconciliation runs unattended on a timer. It must not be able to charge.
    const service = readFileSync(
      join(ROOT, 'packages/kernel/src/services/reconciliation-service.ts'),
      'utf8',
    );
    expect(service).toContain('ReconciliationDependencies');
    expect(service).not.toContain('paymentExecutor');
  });

  it('every money-moving provider method demands a grant', () => {
    const port = readFileSync(join(ROOT, 'packages/core/src/ports/payment-provider.ts'), 'utf8');
    const executorBlock = port.slice(port.indexOf('export interface PaymentExecutor'));
    expect(executorBlock).toContain('createOrder(grant: TGrant');
    expect(executorBlock).toContain('capturePayment(grant: TGrant');

    for (const service of [
      'quote-service',
      'webhook-service',
      'review-service',
      'authorization-service',
      'reconciliation-service',
    ]) {
      const source = readFileSync(join(ROOT, `packages/kernel/src/services/${service}.ts`), 'utf8');
      expect(source).not.toContain('PaymentDependencies');
    }
  });

  it('the guarded executor is the only kernel module that names a raw provider', () => {
    const offenders = sourceFiles('packages/kernel/src').filter(file => {
      if (file.endsWith('payment-executor.ts')) return false;
      return /PaymentProvider/.test(readFileSync(file, 'utf8'));
    });
    expect(offenders.map(f => relative(ROOT, f))).toEqual([]);
  });
});

describe('the kernel is a pure function', () => {
  const pureFiles = [
    ...sourceFiles('packages/kernel/src/stages'),
    join(ROOT, 'packages/kernel/src/kernel.ts'),
    join(ROOT, 'packages/kernel/src/combine.ts'),
    ...sourceFiles('packages/policy/src'),
  ];

  it('no stage reads an ambient clock or a random source', () => {
    const offenders: string[] = [];
    for (const file of pureFiles) {
      const source = readFileSync(file, 'utf8')
        // Ignore prose: only executable code matters here.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bDate\.parse\b|randomUUID/.test(source)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no stage performs I/O', () => {
    const offenders: string[] = [];
    for (const file of pureFiles) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith('node:') && spec !== 'node:crypto')
          offenders.push(`${relative(ROOT, file)} -> ${spec}`);
      }
      if (/\bawait\b|\bfetch\(/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))) {
        offenders.push(`${relative(ROOT, file)} contains await/fetch`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the reason code vocabulary', () => {
  const allSource = [
    ...sourceFiles('packages/kernel/src'),
    ...sourceFiles('packages/policy/src'),
    ...sourceFiles('packages/core/src'),
    ...sourceFiles('packages/agent/src'),
    ...sourceFiles('packages/agent/tests'),
    ...sourceFiles('packages/kernel/tests'),
    ...sourceFiles('apps/api/src'),
    ...sourceFiles('apps/eval/src'),
    ...sourceFiles('tests'),
  ]
    .map(file => readFileSync(file, 'utf8'))
    .join('\n');

  it('has no dead codes: every declared code is referenced outside its definition', () => {
    const definitionFile = readFileSync(join(ROOT, 'packages/core/src/reason-codes.ts'), 'utf8');
    const dead = REASON_CODES.filter(code => {
      const total = allSource.split(code).length - 1;
      const inDefinition = definitionFile.split(code).length - 1;
      return total - inDefinition === 0;
    });
    expect(dead).toEqual([]);
  });

  it('assigns every code to a stage and a severity', () => {
    expect(REASON_CODES.length).toBeGreaterThan(60);
  });
});
