# STEP Style Inspector

This is an isolated raw STEP presentation/style inspection spike. It does not
replace the production converter and does not require OpenCascade.

```bash
python3 spikes/step-style-inspector/step_style_inspector.py \
  /path/to/input.stp \
  --xcaf-report /tmp/u843-xcaf-glb-output-v5/xcaf-report.json \
  --out /tmp/u843-step-style-report.json \
  --crossref-out /tmp/u843-style-xcaf-crossref.json
```

The report summarizes presentation, style, colour, and layer entities without
expanding geometry arrays. It also traces raw STEP colour/style references to
`STYLED_ITEM` entities and, when an XCAF report is supplied, correlates default
grey XCAF objects with raw STEP style candidates by names, labels, layers, and
presentation-layer membership.
