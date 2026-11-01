# Evaluation report

Generated 2026-11-01T10:20:02.431Z on the synthetic held-out split: 1511 test documents (unseen scenario per class, hard cases, prompt-injection and OCR-noise variants), TF-IDF trained on 3644 in 21561 ms, embeddings head in 123674 ms including encoding. LLM: gpt-5.4-mini-2026-03-17.

Synthetic letters are easier than real mail. These numbers validate the mechanics of the cascade, not the production accuracy; that needs the client's labelled sample.

| Mode | Suggestion accuracy | Macro-F1 | Coverage (no human) | Precision of auto-routed | Critical lost | Wrong customer, auto-routed | Injection auto-routed wrong | p95 ms (LLM cached) | LLM tokens |
|---|---|---|---|---|---|---|---|---|---|
| rules only | 0.0% | 0.000 | 0.0% | 0.0% | 143 / 866 | 0 / 1511 | 0 / 40 | 5.3 | 0 |
| rules + embeddings (e5) | 88.7% | 0.885 | 40.6% | 95.9% | 24 / 866 | 0 / 1511 | 0 / 40 | 253.8 | 0 |
| full cascade, embeddings (e5) | 96.6% | 0.966 | 60.3% | 96.8% | 18 / 866 | 0 / 1511 | 0 / 40 | 10.3 | 1151557 |
| rules + local model (TF-IDF) | 93.4% | 0.934 | 57.5% | 98.3% | 15 / 866 | 0 / 1511 | 0 / 40 | 6.5 | 0 |
| full cascade (rules + TF-IDF + LLM) | 97.9% | 0.979 | 67.2% | 98.1% | 12 / 866 | 0 / 1511 | 0 / 40 | 16.0 | 536402 |

### LLM only (no rules, no local model)

One LLM call per letter, with the same acceptance gates as the cascade (grounded quote, confidence, not OTHER), and the same customer matching and routing.

| Mode | Suggestion accuracy | Macro-F1 | Coverage (no human) | Precision of auto-routed | Critical lost | Wrong customer, auto-routed | Injection auto-routed wrong | p95 ms (LLM cached) | LLM tokens |
|---|---|---|---|---|---|---|---|---|---|
| LLM only | 97.9% | 0.979 | 73.6% | 97.8% | 17 / 866 | 0 / 1511 | 0 / 40 | 4.5 | 2726694 |

## Classification cost per 1000 letters (gpt-5.4-mini-2026-03-17, list prices in src/evaluation/cost.ts)

OCR is excluded: it is the same work in every design. Local stages run on the CPU that serves the API.

| Design | LLM calls | Input tokens | Output tokens | LLM cost (USD) | Letters for a person |
|---|---|---|---|---|---|
| full cascade, embeddings (e5) | 425 | 712023 | 50093 | 0.76 | 397 |
| full cascade (rules + TF-IDF + LLM) | 203 | 331619 | 23379 | 0.35 | 328 |
| LLM only | 1000 | 1689135 | 115428 | 1.79 | 264 |

## Details: full cascade (rules + TF-IDF + LLM)

Decided by: local_model 869, human 495, llm 147.

Critical letters lost: complaint-01161, complaint-01162, complaint-01165, complaint-01188, complaint-01190, complaint-01212, law_enforcement_request-01804, gdpr_request-02123, gdpr_request-02133, contract_withdrawal-02774, complaint-01161-slip, complaint-01188-slip.

| Class | Critical | Support | Precision | Recall | F1 | Auto-routed | Auto precision | 95% lower bound |
|---|---|---|---|---|---|---|---|---|
| BAILIFF_SEIZURE | yes | 93 | 1.00 | 1.00 | 1.00 | 67 | 100.0% | 94.6% |
| BAILIFF_INQUIRY | yes | 97 | 0.98 | 1.00 | 0.99 | 83 | 100.0% | 95.6% |
| COURT_LETTER | yes | 100 | 0.99 | 1.00 | 1.00 | 45 | 97.8% | 88.4% |
| COMPLAINT | yes | 109 | 0.97 | 0.90 | 0.93 | 79 | 96.2% | 89.4% |
| REGULATOR_LETTER | yes | 103 | 1.00 | 1.00 | 1.00 | 66 | 100.0% | 94.5% |
| LAW_ENFORCEMENT_REQUEST | yes | 92 | 1.00 | 0.99 | 0.99 | 21 | 100.0% | 84.5% |
| GDPR_REQUEST | yes | 92 | 0.97 | 0.98 | 0.97 | 64 | 95.3% | 87.1% |
| DEATH_NOTIFICATION | yes | 91 | 1.00 | 0.98 | 0.99 | 64 | 100.0% | 94.3% |
| CONTRACT_WITHDRAWAL | yes | 89 | 1.00 | 1.00 | 1.00 | 69 | 100.0% | 94.7% |
| CLAIM_NOTIFICATION |  | 90 | 0.98 | 0.99 | 0.98 | 82 | 97.6% | 91.5% |
| CLAIM_DOCUMENTS |  | 97 | 0.98 | 0.97 | 0.97 | 81 | 98.8% | 93.3% |
| CONTRACT_TERMINATION |  | 95 | 0.86 | 1.00 | 0.93 | 86 | 90.7% | 82.7% |
| PERSONAL_DATA_CHANGE |  | 90 | 0.98 | 0.97 | 0.97 | 63 | 98.4% | 91.5% |
| POWER_OF_ATTORNEY |  | 92 | 0.99 | 1.00 | 0.99 | 66 | 100.0% | 94.5% |
| INVOICE |  | 92 | 1.00 | 1.00 | 1.00 | 80 | 100.0% | 95.4% |
| OTHER |  | 89 | 0.99 | 0.90 | 0.94 | 0 | - | - |

| Slice | n | Suggestion accuracy | Coverage | Precision of auto-routed |
|---|---|---|---|---|
| hard_case | 111 | 97.3% | 40.5% | 95.6% |
| injection | 40 | 100.0% | 22.5% | 100.0% |
| ocr_noise | 40 | 100.0% | 75.0% | 100.0% |
| id_slip | 40 | 92.5% | 0.0% | 0.0% |
| author:gpt-5.4 | 272 | 100.0% | 68.0% | 100.0% |
| author:claude | 1239 | 97.4% | 67.1% | 97.7% |

## Decisive rules, validated on the training split

A rule may decide alone only if the lower 95% bound of its precision on training letters is at least 95%.

| Rule | Label | Fired | Correct | Precision | 95% lower bound | Decides alone |
|---|---|---|---|---|---|---|
| bailiff-seizure | BAILIFF_SEIZURE | 66 | 63 | 95.5% | 87.5% | no, hint only |
| bailiff-inquiry | BAILIFF_INQUIRY | 143 | 140 | 97.9% | 94.0% | no, hint only |
| court-case-number | COURT_LETTER | 251 | 225 | 89.6% | 85.3% | no, hint only |
| tax-office-seizure | BAILIFF_SEIZURE | 22 | 22 | 100.0% | 85.1% | no, hint only |

## Customer matching under OCR damage

2000 letters generated by code from the CRM fixture, each customer given a neighbouring policy number one OCR confusion away that belongs to someone else (policy numbers are sequential, so this is the realistic case). "Exact" is first-exact-hit matching as in the previous version; "hybrid" accepts a match only when a checksummed identifier, a second reference or the customer's name confirms it.

| Case | n | Exact: right customer | Exact: wrong customer | Hybrid: auto, right | Hybrid: auto, wrong | Hybrid: to a person | ...with the right customer suggested first |
|---|---|---|---|---|---|---|---|
| clean number and name | 400 | 400 | 0 | 399 | 0 | 1 | 1 |
| clean number, no name | 400 | 400 | 0 | 0 | 0 | 400 | 400 |
| OCR slip onto a neighbour, name present | 400 | 0 | 400 | 0 | 0 | 400 | 400 |
| OCR slip onto a neighbour, no name | 400 | 0 | 400 | 0 | 0 | 400 | 0 |
| letter read in place of a digit, name present | 400 | 400 | 0 | 399 | 0 | 1 | 1 |

## Learning curve: TF-IDF versus multilingual-e5, local model alone

Trained on stratified samples of the training split, scored on the 1391 plain test letters (unseen scenarios and hard cases). Coverage and precision use each model's own calibrated per-class thresholds.

| Training letters | TF-IDF accuracy | TF-IDF coverage | TF-IDF auto precision | e5 accuracy | e5 coverage | e5 auto precision |
|---|---|---|---|---|---|---|
| 240 | 87.1% | 57.7% | 92.9% | 81.9% | 52.3% | 91.9% |
| 480 | 89.7% | 80.2% | 96.5% | 83.6% | 54.9% | 94.0% |
| 960 | 92.1% | 75.0% | 97.8% | 88.4% | 58.4% | 96.6% |
| 1920 | 93.3% | 72.9% | 97.9% | 89.2% | 59.5% | 97.3% |
| 3644 | 93.4% | 74.6% | 98.0% | 89.1% | 55.4% | 96.4% |

## Risk-coverage of the local model alone

| Threshold | Coverage | Accuracy |
|---|---|---|
| 0.30 | 93.9% | 95.4% |
| 0.40 | 89.9% | 96.5% |
| 0.50 | 83.8% | 97.6% |
| 0.60 | 77.4% | 98.0% |
| 0.70 | 69.5% | 98.6% |
| 0.80 | 59.2% | 99.2% |
| 0.90 | 43.8% | 99.7% |
| 0.95 | 32.1% | 100.0% |

## Calibrated per-class thresholds (out-of-fold)

| Class | Threshold |
|---|---|
| BAILIFF_SEIZURE | 0.541 |
| BAILIFF_INQUIRY | 0.658 |
| COURT_LETTER | 0.825 |
| COMPLAINT | 0.413 |
| REGULATOR_LETTER | 0.852 |
| LAW_ENFORCEMENT_REQUEST | 0.151 |
| GDPR_REQUEST | 0.728 |
| DEATH_NOTIFICATION | 0.828 |
| CONTRACT_WITHDRAWAL | 0.182 |
| CLAIM_NOTIFICATION | 0.571 |
| CLAIM_DOCUMENTS | 0.556 |
| CONTRACT_TERMINATION | 0.162 |
| PERSONAL_DATA_CHANGE | 0.670 |
| POWER_OF_ATTORNEY | 0.223 |
| INVOICE | 0.158 |
| OTHER | never auto |
