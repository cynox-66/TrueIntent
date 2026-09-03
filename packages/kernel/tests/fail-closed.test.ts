/**
 * Proof that no code path leads from an exception to ALLOW.
 *
 * The interesting failure mode is not a stage that correctly reports a problem;
 * it is a stage that *crashes* and is treated as having found nothing. These
 * tests inject a faulting stage into every position in the pipeline and assert
 * that the verdict is DENY in all of them.
 */

import { describe, it, expect } from 'vitest';
import { STAGE_IDS, type StageId } from '@capturelock/core';
import { combine, MANDATORY_STAGES } from '../src/combine.js';
import { runStages, completed, blocked, type VerificationStage } from '../src/pipeline.js';
import { PIPELINE, evaluate } from '../src/kernel.js';
import { buildContext } from './fixtures.js';

const context = buildContext();

function faultingStage(id: StageId): VerificationStage {
  return {
    id,
    run() {
      throw new Error('injected fault');
    },
  };
}

function silentPassStage(id: StageId): VerificationStage {
  return { id, run: () => completed([]) };
}

describe('a throwing stage', () => {
  it.each(STAGE_IDS)('yields DENY when %s throws', stageId => {
    const pipeline = PIPELINE.map(stage => (stage.id === stageId ? faultingStage(stageId) : stage));
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reasonCodes).toContain('KERNEL_STAGE_ERROR');
    expect(decision.reasonCodes).toContain('STAGE_DID_NOT_COMPLETE');
  });

  it('records the stage as ERRORED rather than omitting it', () => {
    const pipeline = PIPELINE.map(stage =>
      stage.id === 'POLICY' ? faultingStage('POLICY') : stage,
    );
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    expect(decision.stages.find(s => s.stage === 'POLICY')?.status).toBe('ERRORED');
  });

  it('does not leak a stack trace into the evidence', () => {
    const pipeline = PIPELINE.map(stage =>
      stage.id === 'INTENT' ? faultingStage('INTENT') : stage,
    );
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    const errorFinding = decision.findings.find(f => f.code === 'KERNEL_STAGE_ERROR');
    expect(errorFinding?.detail['error']).toBe('Error: injected fault');
    expect(JSON.stringify(decision)).not.toContain('at Object');
  });

  it('yields DENY even when every stage throws at once', () => {
    const pipeline = STAGE_IDS.map(faultingStage);
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    expect(decision.verdict).toBe('DENY');
  });

  it('survives a stage that throws a non-Error value', () => {
    const rogue: VerificationStage = {
      id: 'POLICY',
      run() {
        throw 'a string, not an Error';
      },
    };
    const pipeline = PIPELINE.map(stage => (stage.id === 'POLICY' ? rogue : stage));
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    expect(decision.verdict).toBe('DENY');
    expect(decision.findings.find(f => f.code === 'KERNEL_STAGE_ERROR')?.detail['error']).toBe(
      'non-error thrown',
    );
  });
});

describe('a missing or blocked stage', () => {
  it.each(STAGE_IDS)('yields DENY when %s is absent from the pipeline entirely', stageId => {
    const pipeline = PIPELINE.filter(stage => stage.id !== stageId);
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reasonCodes).toContain('STAGE_DID_NOT_COMPLETE');
  });

  it.each(STAGE_IDS)('yields DENY when %s reports itself blocked', stageId => {
    const pipeline = PIPELINE.map(stage =>
      stage.id === stageId ? { id: stageId, run: () => blocked('missing input') } : stage,
    );
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    expect(decision.verdict).toBe('DENY');
  });

  it('yields DENY for a completely empty pipeline', () => {
    const decision = combine(runStages([], context), 'CAPTURE', context.evaluatedAt);
    expect(decision.verdict).toBe('DENY');
    expect(decision.findings).toHaveLength(MANDATORY_STAGES.length);
  });
});

describe('the combiner cannot be talked into ALLOW', () => {
  it('requires every mandatory stage, and there are no optional ones', () => {
    expect([...MANDATORY_STAGES].sort()).toEqual([...STAGE_IDS].sort());
  });

  it('allows only when every stage completed with no findings', () => {
    const pipeline = STAGE_IDS.map(silentPassStage);
    const decision = combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt);
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.reasonCodes).toEqual(['VERIFIED_MATCH']);
  });

  it('takes the maximum severity, so one DENY outweighs any number of passes', () => {
    const pipeline: VerificationStage[] = STAGE_IDS.map(silentPassStage);
    pipeline[3] = {
      id: 'INTENT',
      run: () =>
        completed([
          {
            code: 'MERCHANT_NOT_AUTHORIZED',
            severity: 'DENY',
            stage: 'INTENT',
            message: 'x',
            detail: {},
          },
        ]),
    };
    expect(combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt).verdict).toBe(
      'DENY',
    );
  });

  it('yields PAUSE when the highest severity is PAUSE, never ALLOW', () => {
    const pipeline: VerificationStage[] = STAGE_IDS.map(silentPassStage);
    pipeline[6] = {
      id: 'EXECUTION',
      run: () =>
        completed([
          {
            code: 'RETRY_VELOCITY_EXCEEDED',
            severity: 'PAUSE',
            stage: 'EXECUTION',
            message: 'x',
            detail: {},
          },
        ]),
    };
    expect(combine(runStages(pipeline, context), 'CAPTURE', context.evaluatedAt).verdict).toBe(
      'PAUSE',
    );
  });

  it('is unaffected by stage ordering, since findings form a set', () => {
    const forwards = evaluate(context);
    const reversed = combine(
      runStages([...PIPELINE].reverse(), context),
      'CAPTURE',
      context.evaluatedAt,
    );
    expect(reversed.verdict).toBe(forwards.verdict);
    expect([...reversed.reasonCodes].sort()).toEqual([...forwards.reasonCodes].sort());
  });
});
