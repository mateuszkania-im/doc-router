import type { Prediction, TextClassifier } from '../classifier/local-classifier.js';
import { isCritical, type DocumentClass } from '../domain/classes.js';
import type {
  Channel,
  Classification,
  ExtractedText,
  ReviewReason,
  Stage,
  StageTrace,
} from '../domain/types.js';
import { classifyWithLlm, evidenceIsGrounded } from '../llm/llm-classifier.js';
import type { LlmUsage, StructuredLlm } from '../llm/structured-llm.js';
import { applyRules, labelExplainsSignals, type RulePolicy } from './rules.js';

const STRUCTURED_CHANNELS: ReadonlySet<Channel> = new Set(['OGNIVO', 'E_DORECZENIA']);

/** Local model top-1 above this, disagreeing with the LLM, means the two sieves contradict. */
const CONFLICT_CONFIDENCE = 0.5;

/**
 * Asymmetric cost: when the local model picks an ordinary class but gives a critical one at least
 * this much probability, it does not decide alone. A termination that hides a complaint looks
 * like a termination with a complaint-shaped shadow, and the shadow is the part with a deadline.
 * Fixed before looking at results, not tuned on the test split.
 */
export const CRITICAL_RUNNER_UP = 0.2;

const criticalShadow = (local: Prediction): Prediction['ranking'][number] | undefined =>
  isCritical(local.label)
    ? undefined
    : local.ranking.find(
        (r) => r.label !== local.label && isCritical(r.label) && r.score >= CRITICAL_RUNNER_UP,
      );

export interface CascadeDeps {
  readonly localClassifier?: TextClassifier;
  readonly llm?: StructuredLlm;
  readonly llmMinConfidence: number;
  readonly ocrQualityFloor: number;
  /** Rules allowed to decide alone, from `calibrateRules`. Absent: every decisive rule may. */
  readonly rulePolicy?: RulePolicy;
}

export interface CascadeInput {
  readonly text: ExtractedText;
  readonly channel: Channel;
  readonly declaredClass?: DocumentClass;
}

export interface CascadeResult {
  readonly classification: Classification;
  readonly llmUsage?: LlmUsage;
}

interface Decision {
  readonly label: DocumentClass;
  readonly stage: Stage;
  readonly confidence: number;
  readonly evidence?: string;
}

const elapsed = (start: number): number => Math.round((performance.now() - start) * 100) / 100;

/**
 * Cheapest sieve first, each one allowed to say "I don't know". The LLM only sees what the
 * channel, rules and local model could not settle, and a human sees what nobody could.
 */
export async function runCascade(input: CascadeInput, deps: CascadeDeps): Promise<CascadeResult> {
  const trace: StageTrace[] = [];
  const reasons = new Set<ReviewReason>();
  let decision: Decision | undefined;
  let suggestion: DocumentClass | null = null;
  let llmUsage: LlmUsage | undefined;
  const text = input.text.text;

  // Stage 0: a structured channel already tells us the type.
  let t = performance.now();
  if (input.declaredClass && STRUCTURED_CHANNELS.has(input.channel)) {
    decision = { label: input.declaredClass, stage: 'channel', confidence: 1 };
    trace.push({
      stage: 'channel',
      outcome: 'decided',
      label: input.declaredClass,
      confidence: 1,
      detail: `type declared by ${input.channel}`,
      durationMs: elapsed(t),
    });
  } else {
    trace.push({
      stage: 'channel',
      outcome: 'skipped',
      detail: `${input.channel} carries no declared type`,
      durationMs: elapsed(t),
    });
  }

  if (input.text.error) reasons.add('text_extraction_failed');
  else if (input.text.quality < deps.ocrQualityFloor) reasons.add('low_ocr_quality');

  // Stage 1: rules. Always run: even a decided document gets the safety net and injection check.
  t = performance.now();
  const rules = applyRules(text, deps.rulePolicy);
  if (rules.suspiciousInstructions) reasons.add('suspicious_instructions');
  if (!decision && rules.label) {
    decision = { label: rules.label, stage: 'rules', confidence: 0.99 };
    trace.push({
      stage: 'rules',
      outcome: 'decided',
      label: rules.label,
      confidence: 0.99,
      detail: `decisive rule(s): ${rules.trustedRules.join(', ')}`,
      durationMs: elapsed(t),
    });
  } else {
    const net = rules.safetyNet.length
      ? `safety net: ${rules.safetyNet.join(', ')}`
      : 'no critical signal';
    const untrusted = rules.matchedRules.filter((r) => !rules.trustedRules.includes(r));
    const why = decision
      ? 'already decided'
      : rules.trustedRules.length > 1
        ? `conflicting rules: ${rules.trustedRules.join(', ')}`
        : untrusted.length
          ? `matched ${untrusted.join(', ')}, not precise enough on training data to decide alone`
          : 'no decisive rule';
    trace.push({
      stage: 'rules',
      outcome: decision ? 'skipped' : 'abstained',
      detail: `${why}; ${net}`,
      durationMs: elapsed(t),
    });
  }

  // Stage 2: local model.
  t = performance.now();
  // Not run once a cheaper stage decided: an encoder model costs real milliseconds.
  const local = decision ? undefined : await deps.localClassifier?.predict(text);
  const shadow = local ? criticalShadow(local) : undefined;
  if (decision) {
    trace.push({
      stage: 'local_model',
      outcome: 'skipped',
      detail: 'already decided',
      durationMs: elapsed(t),
    });
  } else if (!local) {
    trace.push({
      stage: 'local_model',
      outcome: 'skipped',
      detail: 'no trained model loaded',
      durationMs: elapsed(t),
    });
  } else {
    suggestion = local.label;
    const detail = `top ${local.label} p=${local.confidence.toFixed(3)} vs threshold ${local.threshold.toFixed(3)}${shadow ? `, but critical ${shadow.label} at p=${shadow.score.toFixed(3)}` : ''}`;
    if (local.accepted && !shadow) {
      decision = { label: local.label, stage: 'local_model', confidence: local.confidence };
      trace.push({
        stage: 'local_model',
        outcome: 'decided',
        label: local.label,
        confidence: local.confidence,
        detail,
        durationMs: elapsed(t),
      });
    } else {
      trace.push({
        stage: 'local_model',
        outcome: 'abstained',
        label: local.label,
        confidence: local.confidence,
        detail,
        durationMs: elapsed(t),
      });
    }
  }

  // Stage 3: LLM for the uncertain band only.
  t = performance.now();
  if (decision) {
    trace.push({
      stage: 'llm',
      outcome: 'skipped',
      detail: 'already decided',
      durationMs: elapsed(t),
    });
  } else if (!deps.llm) {
    trace.push({
      stage: 'llm',
      outcome: 'skipped',
      detail: 'LLM disabled',
      durationMs: elapsed(t),
    });
  } else {
    try {
      const { verdict, usage } = await classifyWithLlm(deps.llm, text);
      llmUsage = usage;
      const grounded = evidenceIsGrounded(verdict.evidence, text);
      // A local "OTHER" means "unsure", which is exactly the LLM's job, not a contradiction.
      // Agreeing with the critical runner-up the local model itself raised is not a contradiction.
      const conflict =
        local !== undefined &&
        local.label !== 'OTHER' &&
        local.confidence >= CONFLICT_CONFIDENCE &&
        local.label !== verdict.label &&
        shadow?.label !== verdict.label;
      // Asymmetric cost again: the local model leaning to a critical class and the LLM moving the
      // letter to an ordinary one is the expensive direction of error, so a person settles it.
      const downgrade =
        local !== undefined &&
        isCritical(local.label) &&
        local.confidence >= CRITICAL_RUNNER_UP &&
        !isCritical(verdict.label);
      const base = `${verdict.label} p=${verdict.confidence.toFixed(2)}, evidence ${grounded ? 'grounded' : 'NOT found in text'}${conflict ? `, contradicts local model (${local.label})` : ''}${downgrade ? `, moves critical ${local.label} to an ordinary class` : ''}`;
      // In the uncertain band the LLM is the stronger reader, including when it says "none of these".
      suggestion = verdict.label;
      if (verdict.label !== 'OTHER' && !grounded) reasons.add('ungrounded_evidence');
      if (conflict || downgrade) reasons.add('model_conflict');
      if (
        verdict.label !== 'OTHER' &&
        grounded &&
        !conflict &&
        !downgrade &&
        verdict.confidence >= deps.llmMinConfidence
      ) {
        decision = {
          label: verdict.label,
          stage: 'llm',
          confidence: verdict.confidence,
          evidence: verdict.evidence,
        };
        trace.push({
          stage: 'llm',
          outcome: 'decided',
          label: verdict.label,
          confidence: verdict.confidence,
          detail: base,
          durationMs: elapsed(t),
        });
      } else {
        trace.push({
          stage: 'llm',
          outcome: 'abstained',
          label: verdict.label,
          confidence: verdict.confidence,
          detail: base,
          durationMs: elapsed(t),
        });
      }
    } catch (error) {
      // An LLM outage degrades to human review; it never blocks intake.
      const message = error instanceof Error ? error.message : String(error);
      trace.push({
        stage: 'llm',
        outcome: 'abstained',
        detail: `LLM error: ${message}`,
        durationMs: elapsed(t),
      });
    }
  }

  if (!decision) reasons.add('cascade_abstained');

  // The keyword net can veto any stage: a critical signal the final label does not explain means
  // a person looks at it, fast. A false alarm costs minutes; a missed seizure costs damages.
  if (decision && !labelExplainsSignals(rules, decision.label)) {
    reasons.add('safety_net_conflict');
  }

  return {
    classification: {
      label: decision?.label ?? null,
      decidedBy: decision?.stage ?? null,
      confidence: decision?.confidence ?? 0,
      suggestedLabel: decision?.label ?? suggestion,
      ...(decision?.evidence ? { evidence: decision.evidence } : {}),
      safetyNet: rules.safetyNet,
      reviewReasons: [...reasons],
      trace,
    },
    ...(llmUsage ? { llmUsage } : {}),
  };
}
