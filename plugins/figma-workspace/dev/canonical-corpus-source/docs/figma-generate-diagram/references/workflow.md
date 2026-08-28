# Hybrid Diagram Workflow

Mermaid's syntax can't express everything a good diagram needs — annotations tied to specific data, domain color-coding, callouts that live _next_ to the diagram rather than inside it. This reference covers the **hybrid workflow**: use the upstream diagram capability to scaffold the structural diagram, then use a local `.figma.ts` script executed with `figma:run` to layer on what Mermaid can't do. Consult the [FigJam API mirror](canonical:figma-use-figjam/SKILL.md) only for the specific Plugin API operations needed.

**This is a judgment tool, not a procedure.** The hybrid workflow costs extra tokens and latency. Deploy it when the user's ask genuinely benefits — not on every diagram. When in doubt, ship the base diagram first; the user can tell you what's missing.

## 1. When to reach for the hybrid workflow

Signals that say **yes, go hybrid**:

- User explicitly asks for something Mermaid can't do — _"add notes explaining the branches"_, _"color-code by team"_, _"callout the drop-offs with conversion numbers"_, _"annotate the critical path with the SLA"_.
- User shared attachable data (quotes, metrics, research notes, ticket links) that clearly maps to specific nodes.
- The diagram is complex enough that side-detail genuinely helps readability — dense subgraphs, long chains, branching flows where comments on specific steps would unblock a reader.
- The user is framing this as a shareable artifact (_"for our team review"_, _"so PMs can follow"_) rather than a quick thinking sketch.

Signals that say **no, single-tool is enough**:

- Short / self-explanatory request (_"diagram our auth flow"_ with no adjectives).
- User appears to be testing or exploring — small scope, minimal language, no data to attach.
- Small diagram (<8 nodes) where any annotation would be noisier than useful.
- Flowchart request where the only "extension" would be color — Mermaid subgraph styling already handles this (see [flowchart.md §4](canonical:figma-generate-diagram/references/flowchart.md)).

Bias toward action. The end goal is giving the user a file they can work with and keep iterating on — not producing a perfect artifact. Something is better than nothing; nothing is frustrating.

## 2. Traffic-shaped priorities

Not all diagram types benefit equally. Rough priority for deploying the workflow:

1. **Flowchart** — highest value is _annotation_ (notes, callouts, attached data). Color-coding is already covered natively by Mermaid subgraph styling — **skip color recipes for flowcharts** and route to [flowchart.md](canonical:figma-generate-diagram/references/flowchart.md) if that's all the user wants.
2. **ERD** — highest value is _domain color-coding_ (group tables by auth / billing / content / etc.) and _table-level annotations_. Mermaid's ERD styling is stripped by our preprocessor, so a local `.figma.ts` script executed by `figma:run` is the only path.
3. **Sequence / state / gantt** — smaller audiences; be conservative. Use the same recipes if the user explicitly asks, but don't volunteer heavy workflow on these.

## 3. The pattern

```
1. Generate: call the upstream diagram capability → capture fileKey from the returned URL
2. (Optional) Inspect: run a read-only local `.figma.ts` script with `figma:run -- --file <file-key> --surface figjam --script <path>`
   for broad or anchor discovery, then use `figma:inspect -- --file <file-key> --node <node-id> --surface figjam`
   for precise targeted reads when extensions need anchors
3. Extend: run a local `.figma.ts` script with `figma:run` with the same fileKey, applying one or more recipes
4. Report: share the file link + a one-line summary of what you added
```

**fileKey reuse is non-negotiable.** Every `figma:run` call after generation must pass the `fileKey` you parsed from the the upstream diagram capability response URL (`figma.com/board/{fileKey}/...`). Never call `schema-confirmed upstream file creation` in this workflow — extensions go into the same file as the diagram. Multiple drafts pollute the user's file list.

**Inspection is optional.** Skip discovery when your extensions don't need precise anchoring (e.g., adding a title text block above the diagram, adding a legend off to one side). Run a read-only `.figma.ts` discovery script and then targeted `figma:inspect` when you need to know where a specific node ended up (e.g., placing a sticky note adjacent to "Login" step).

## 4. Recipe: Annotations (label + legend pattern)

The single most universal extension. Works for every diagram type. Proven especially effective on dense diagrams (architecture, sequence, large flowcharts).

**The opinionated default — label circles + sticky legend:**

Place a small numbered circle ("pin") on or near each annotated node, then cluster the corresponding sticky notes as a **legend** off to the side of the diagram. The diagram stays clean; readers can reference "point 3" unambiguously; 10 annotations is as scannable as 3.

Use [create-label](canonical:figma-use-figjam/references/create-label.md) for the pin circles and [create-sticky](canonical:figma-use-figjam/references/create-sticky.md) for the legend entries. That reference has a full worked example of the label-plus-legend pattern (`## Label + Sticky Legend` section) — follow it.

**When to use:**

- User asked for notes, callouts, annotations, comments, or "explain X".
- User provided data (conversion rates, latency numbers, quotes, ticket links, rationale) that maps to specific nodes.
- Three or more nodes in the diagram merit annotation — once you're past a couple, the legend pattern is strictly better than free-floating stickies.
- Shareable artifact ("for team review", "for the PRD") — the legend format reads as designed rather than scribbled.

**How:**

1. Run a read-only `.figma.ts` script with `figma:run` against `<file-key>` to read back the diagram and find candidate node IDs and bounding boxes; use targeted `figma:inspect` for each anchor you will annotate.
2. Create one label circle per annotated node, colored consistently (e.g. all `PRESET_BLUE`), positioned at the node's top-left corner (offset by half the label size so it overlaps the corner slightly).
3. Create the matching stickies in a vertical column to the right of the diagram, prefixed with the number (`1. Drop-off: 42% last quarter`).
4. Follow the create-label reference's three-pass pattern (create labels, position on nodes, cluster legend) — especially the conflict-detection logic for pushing the legend past any existing content.

**Fallback — plain sticky adjacent (1–2 annotations only):**

If the user wants to annotate just one or two nodes and a legend would be visual overhead, place a single sticky directly adjacent to the target node (right side preferred, then above, then below). Keep text short. Optionally wire a connector from sticky to node with `create-connector` if position alone doesn't make the association clear. Past two annotations, switch to the label+legend pattern — don't scale stickies-on-nodes up.

**Don'ts:**

- Don't annotate every node. If it annotates everything, it annotates nothing. Pick the nodes that carry disproportionate importance.
- Don't rewrite information that's already in the node label.
- Don't place the sticky immediately adjacent to its label circle — if they're glued together, the circle is redundant. Legend goes in a cluster, not one-per-node.
- Don't mix the two forms — commit to labels+legend or commit to adjacent-stickies, not both in the same diagram.

## 5. Recipe: Color-coding (domain / status tinting)

**When to use:**

- **ERD** — color tables by domain (auth / billing / content). Primary use case.
- **Sequence / state** — color participants or states by role (user-facing vs internal, terminal vs active vs error).
- **NOT flowchart** — use Mermaid subgraph styling via [flowchart.md §4](canonical:figma-generate-diagram/references/flowchart.md) instead. If the user specifically wants per-node coloring that Mermaid can't do, fall through to this recipe, but start with the native path.

**How:**

1. Run a read-only `.figma.ts` discovery script with `figma:run` against `<file-key>` to find candidate nodes, then use targeted `figma:inspect` to confirm the node IDs you want to recolor.
2. Use `batch-modify` (see [figma-use-figjam/references/batch-modify.md](canonical:figma-use-figjam/references/batch-modify.md)) to update fills in a single call. Group by color assignment so one batch covers all nodes getting the same tint.
3. Pick from FigJam's built-in palette (documented in [create-shape-with-text.md](canonical:figma-use-figjam/references/create-shape-with-text.md)) rather than freehand hex values — keeps the diagram visually coherent with the rest of the canvas.

**Don'ts:**

- Don't use saturated / high-contrast colors as fills — text inside colored shapes becomes hard to read. Stick to light tints.
- Don't color every node differently. Color groups, not individuals. If every node has its own color, the color isn't carrying meaning.
- Don't also add a sticky-note legend unless the user asked — the coloring should be self-explanatory in context (e.g., grouped tables), or the user can infer from node names.

## 6. Communication pattern

Two things matter; the rest is up to the model's normal style and user preferences.

- **One-liner up front when the plan isn't obvious from the ask.** If the user said _"diagram our auth flow"_, no preamble needed. If they said _"diagram our auth flow, highlight the drop-offs"_, a short _"Generating the diagram, then adding callouts for the drop-offs"_ sets expectations. Don't ask for approval; the user already asked.
- **Share the file link as soon as the upstream diagram capability returns — before running extensions.** The base diagram is the first deliverable; users would rather open it and start looking while extension work continues than wait for a "finished" version. A sentence like _"Here's the base diagram: [link]. Adding the callouts now."_ is enough.

Everything else is up to you and your typical interactions with the user.

Ambiguous request? Pick a reasonable extension, do it, and narrate what you chose so the user can redirect. Don't ask a clarifying question when a reasonable default exists.

## 7. When extensions fail partway

If a local `.figma.ts` script executed with `figma:run` fails after the upstream diagram capability succeeded, the user already has the file link from step 3 of the communication flow. Classify the extension result before describing the file:

- **Do not** retry in a loop or blindly rerun an `outcome_unknown` extension.
- Give each created extension node a deterministic, operation-specific name and return every created ID before doing optional follow-up work. For `failed_atomic`, retain the direct host/script diagnostics, repair the extension, and retry safely: Figma confirmed the file is unchanged. For `outcome_unknown`, follow `retryGuidance`, inspect returned IDs first, then narrowly read back the exact names within the expected parent and bounds. Shared PluginData is only an optional, host-verified supplement and never a recovery prerequisite. For `not_started`, repair the pre-dispatch cause before another attempt. For `succeeded`, retain the confirmed extension even if later local persistence failed.
- **Do** report clearly what landed and what remains. _"The base diagram is in the file. The callout extension has an unknown outcome, so I read back the returned IDs and scoped callout names: two callouts landed and one remains. I did not rerun the mutation."_
- Partial progress is still progress. The user can open the file and continue from there.

## 8. What NOT to do in MVP

- **Don't reposition nodes.** ELK's layout is what it is for now. If the diagram looks cramped or tangled, the fix is better Mermaid, not manual repositioning via a local `.figma.ts` script executed with `figma:run`.
- **Do not default to building the diagram from scratch with a local `.figma.ts` script.** If the upstream diagram capability can produce a reasonable base, use it; reserve `figma:run` scripts for additive extensions, not replacement.
- **Don't over-extend.** If the user asked for something simple, give them something simple. Every unrequested sticky or color choice is noise.
- **Don't turn the workflow into a checklist.** If the user says _"diagram our API flow"_ with no qualifiers, the right answer is a single the upstream diagram capability call — not a scaffold-and-extend ceremony.

## 9. End goal

The file you ship is a **starting point**. Users will open it in FigJam and keep iterating — moving things, recoloring, adding their own stickies. The hybrid workflow's job is to give them a better starting point, not a finished deliverable. Don't aim for pixel-perfect; aim for useful-immediately.
