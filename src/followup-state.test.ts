import { beforeEach, describe, expect, it } from 'vitest';

import {
  answerLocalFollowUp,
  clearRememberedDiagnoses,
  followupEvidenceKey,
  recallDiagnosis,
  recallLocalDiagnosis,
  rememberDiagnosis,
  rememberLocalDiagnosis,
} from './followup-state.js';

describe('MCP follow-up diagnosis identity', () => {
  beforeEach(() => clearRememberedDiagnoses());

  it('recalls one diagnosis from the same privacy-filtered original evidence', () => {
    const key = followupEvidenceKey('rank 3 Xid 79\nNCCL abort');
    rememberDiagnosis(key, 'diag_context_01');
    expect(recallDiagnosis(key)).toBe('diag_context_01');
    expect(recallDiagnosis(followupEvidenceKey('different logs'))).toBeUndefined();
  });

  it('rejects malformed identities instead of sending an unbound follow-up', () => {
    const key = followupEvidenceKey('CUDA out of memory');
    rememberDiagnosis(key, 'short');
    expect(recallDiagnosis(key)).toBeUndefined();
  });

  it('remembers and recalls local diagnoses up to the limit', () => {
    const key1 = 'local_key_1';
    const key2 = 'local_key_2';
    const diag1 = { summary: 'local 1' } as any;
    const diag2 = { summary: 'local 2' } as any;

    rememberLocalDiagnosis(key1, diag1);
    rememberLocalDiagnosis(key2, diag2);

    expect(recallLocalDiagnosis(key1)).toBe(diag1);
    expect(recallLocalDiagnosis('missing')).toBeUndefined();
  });

  it('answers local follow-ups using the local diagnosis view', () => {
    const diag = {
      summary: 'It broke.',
      primaryFix: 'Fix it.',
      resumeSafetyNote: 'Safe to resume.',
      resumeFrom: 'epoch 4'
    } as any;
    expect(answerLocalFollowUp('what is the cause?', diag)).toBe('It broke.');
    expect(answerLocalFollowUp('how to fix?', diag)).toBe('Fix it.');
    expect(answerLocalFollowUp('is it safe to resume?', diag)).toContain('Safe to resume.');
    expect(answerLocalFollowUp('is it safe to resume?', diag)).toContain('epoch 4');
  });
});
