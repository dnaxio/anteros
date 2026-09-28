---
name: ml-conventions
description: The tenant's ML conventions — feature naming, training splits, review gates.
---

# Conventions

- Features are `snake_case`, prefixed by their source (`crm_`, `billing_`).
- A model only ships with a held-out split and a written evaluation.
