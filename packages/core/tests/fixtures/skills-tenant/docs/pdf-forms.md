---
name: pdf-forms
description: Fill, flatten and merge PDF forms. Use it for any AcroForm work.
license: MIT
compatibility: Needs the `pdftk` binary on the host.
metadata:
  owner: platform
  reviewed: 2026-09-24
allowed-tools: read_pdf write_pdf
---

# Filling a form

1. Dump the fields: `pdftk form.pdf dump_data_fields`.
2. Build the FDF, then fill it: `pdftk form.pdf fill_form data.fdf output out.pdf`.
3. Flatten: `pdftk out.pdf output flat.pdf flatten`.

Never flatten before the signature step — it makes the form read-only.
