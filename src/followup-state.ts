import { createHash } from 'node:crypto';
import type { DiagnosisView } from './format.js';

const diagnosisIds = new Map<string, string>();
const localDiagnoses = new Map<string, DiagnosisView>();

export function followupEvidenceKey(privacyFilteredLogs: string): string {
  return createHash('sha256').update(privacyFilteredLogs).digest('hex');
}

export function rememberDiagnosis(key: string, diagnosisId: string): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(diagnosisId)) return;
  diagnosisIds.delete(key);
  diagnosisIds.set(key, diagnosisId);
  while (diagnosisIds.size > 50) {
    const oldest = diagnosisIds.keys().next().value as string | undefined;
    if (!oldest) break;
    diagnosisIds.delete(oldest);
  }
}

export function recallDiagnosis(key: string): string | undefined {
  const diagnosisId = diagnosisIds.get(key);
  if (!diagnosisId) return undefined;
  diagnosisIds.delete(key);
  diagnosisIds.set(key, diagnosisId);
  return diagnosisId;
}

export function clearRememberedDiagnoses(): void {
  diagnosisIds.clear();
  localDiagnoses.clear();
}

export function rememberLocalDiagnosis(key: string, view: DiagnosisView): void {
  localDiagnoses.delete(key);
  localDiagnoses.set(key, view);
  while (localDiagnoses.size > 50) {
    const oldest = localDiagnoses.keys().next().value as string | undefined;
    if (!oldest) break;
    localDiagnoses.delete(oldest);
  }
}

export function recallLocalDiagnosis(key: string): DiagnosisView | undefined {
  const view = localDiagnoses.get(key);
  if (!view) return undefined;
  localDiagnoses.delete(key);
  localDiagnoses.set(key, view);
  return view;
}

export function answerLocalFollowUp(question: string, diagnosis?: DiagnosisView): string {
  if (!diagnosis) return 'Diagnose a log first. Local follow-ups can explain its cause, evidence, fix, and checkpoint safety without sending data to a model.';
  if (/checkpoint|resum|restart|safe/i.test(question)) {
    return [diagnosis.resumeSafetyNote, diagnosis.resumeFrom ? "Resume evidence: " + diagnosis.resumeFrom : "Checkpoint integrity has not been established by this answer. Verify checksums and manifests before resuming."].filter(Boolean).join('\n\n');
  }
  if (/evidence|why|proof|line/i.test(question)) {
    return diagnosis.evidence.length ? "Matched evidence from this diagnosis:\n\n" + diagnosis.evidence.join("\n\n") : "This diagnosis did not return matched evidence. Collect the initiating error before attributing a cause.";
  }
  if (/verify|verification|test/i.test(question)) return diagnosis.verification || "No safe automated verification command was established from this evidence.";
  if (/fix|action|repair|next|mitigat/i.test(question)) return [diagnosis.primaryFix, diagnosis.fallbackFix, diagnosis.emergencyFix].filter(Boolean).join("\n\n") || "No remediation was established from this evidence.";
  if (/cause|first|rank|happen|summary/i.test(question)) return diagnosis.summary || "No root cause was established from this evidence.";
  return 'Local follow-ups explain recorded findings, not arbitrary questions. Ask what failed first, why, which evidence supports it, how to fix it, how to verify it, or whether the checkpoint is safe. General reasoning requires explicitly choosing cloud review.';
}
