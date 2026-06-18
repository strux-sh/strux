# Strux Docs Style Guide

Rules for writing pages in this documentation site.

## Audience

Two readers, equally important:

1. A **web developer** who has never built an embedded Linux image. Knows React/Vue/Vite/Go basics; has never heard of U-Boot, device trees, or rootfs overlays.
2. An **embedded Linux developer** who wants a web UI. Knows kernels and bootloaders; may not know Vite or WebSockets.

Never assume knowledge from "the other side." The first time an embedded term (rootfs, defconfig, device tree, overlay, compositor) or web term (HMR, Vite, WebSocket) appears in a page, explain it in one sentence — inline or in a `::: tip` box — then move on.

## Tone

- Plain, friendly, direct. Short sentences. Second person ("you").
- Teach the concept right before the reader needs it, not in an abstract preamble.
- Every page starts with 1–3 sentences saying what the page covers and why the reader cares.
- Prefer a worked example over an abstract description. Use realistic values taken from the template project (`strux init` output) or the qemu BSP.

## Accuracy (hard rules)

- **Only document behavior verified in the source code.** If you can't point to the file that implements it, don't write it.
- Never invent CLI flags, YAML keys, env vars, file paths, or API methods. Copy them from `src/index.ts`, the Zod schemas in `src/types/`, and `pkg/runtime/`.
- Dual rootfs / A-B updates are **experimental**: document the conventions BSP owners must follow for v0.3.0 builds, but mark the page and any mention with an experimental warning (`::: warning Experimental`). The design may change.
- The runtime extension system is stable — document it normally.

## Formatting

- One `#` H1 per page; it becomes the page title. Sidebar depth shows `##` headings.
- Use VuePress containers: `::: tip`, `::: warning`, `::: danger` (with optional title after the keyword).
- Fenced code blocks always have a language (`bash`, `yaml`, `go`, `ts`, `vue`, `txt`).
- YAML examples must validate against the real Zod schemas.
- Link related pages liberally with root-relative links, e.g. `[build pipeline](/concepts/build-pipeline.html)`.
- Tables for option/key listings: columns `Key | Type | Default | Description` (reference pages) or `Flag | Description` (CLI).
- Keep lines of prose unwrapped (one paragraph = one line in the source).

## Page structure

- **Guide pages**: goal-oriented walkthrough. Intro → prerequisites (if any) → numbered or sectioned steps with commands and expected output → "Where to go next" links.
- **Concept pages**: explain how a subsystem works. Intro → the mental model (diagram or analogy if useful) → details → links to relevant guide/reference pages.
- **Reference pages**: exhaustive and scannable. Intro sentence → tables/sections covering every option. No tutorials here; link to guides instead.
