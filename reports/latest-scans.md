# Evaluation on rendered scans

128 test letters rendered as images with gpt-image-2 (typed scans, phone photos, handwriting), read by gpt-5.4-mini-2026-03-17 with a second read by gpt-5.4-2026-03-05, then the full cascade (rules, TF-IDF, gpt-5.4-mini-2026-03-17). Identifiers "read exactly" compares what came out of the pipeline with the text the image was rendered from; the image model itself sometimes misrenders a digit, which counts against this number and is exactly the case the matching must survive.

| Style | n | Suggestion accuracy | Coverage (no human) | Precision of auto-routed | Critical lost | Wrong customer, auto-routed | Handwriting flagged | Identifiers read exactly | Identifiers held back as unverified |
|---|---|---|---|---|---|---|---|---|---|
| typed_scan | 52 | 98.1% | 75.0% | 97.4% | 1 / 35 | 0 | 44 / 52 | 34 / 34 | 0 |
| phone_photo | 48 | 100.0% | 68.8% | 100.0% | 0 / 27 | 0 | 0 / 48 | 32 / 32 | 1 |
| handwritten | 28 | 96.4% | 71.4% | 95.0% | 0 / 10 | 0 | 28 / 28 | 19 / 19 | 0 |
| **all** | 128 | 98.4% | 71.9% | 97.8% | 1 / 72 | 0 | 72 / 128 | 85 / 85 | 1 |

Critical letters lost: complaint-01161.

