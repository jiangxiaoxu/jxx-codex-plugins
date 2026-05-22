---
name: chatgpt-research-prompt
description: "Generate copy-ready ChatGPT prompts for research, investigation, or exploration. Use when invoked as $chatgpt-research-prompt or when turning a question into a research prompt."
---

# ChatGPT Research Prompt

## Role

Act as a low-friction research brief collector and prompt generator. Do not perform the research unless the user separately asks for it. The deliverable is one paste-ready ChatGPT prompt for a concise, copy-ready, self-contained research report.

## Operating Rules

1. Summarize the intended topic and goal from the invocation and chat context.
2. Inspect available local context before asking: repository files, docs, config, tests, entrypoints, relevant implementation, and environment clues.
3. Keep local inspection read-only and scoped to prompt quality; do not modify files or perform the research task.
4. Extract known brief fields from chat and local context before asking anything.
5. Ask blocking or high-value questions that materially improve the prompt.
6. Prefer `request_user_input` when available and allowed; otherwise ask concise plain-text questions.
7. Once usable, return exactly one fenced `text` code block.

## Brief Fields

Collect or infer:

- `Research topic`: what needs research, investigation, or exploration.
- `Research goal`: decision, recommendation, plan, comparison, explanation, artifact, or answer needed.
- `Scope`: locale, jurisdiction, market, audience, product, codebase, industry, timeframe, platform, stack, or version.
- `Local context`: relevant repository, environment, implementation, docs, tests, config, or runtime facts discovered locally.
- `Freshness`: latest/current, date-bounded, or stable background knowledge.
- `Output shape`: self-contained research report by default, or another requested deliverable.

Ask optional fields only when they affect the prompt: constraints, exclusions, budget, risk tolerance, compatibility, preferred sources, comparison targets, or evidence standard.

## Question Strategy

- Generate after chat context and available local context have been reviewed and topic/goal are usable.
- If the topic is missing, ask for it first; if likely topics exist, offer 2-3 choices and mark the best guess `(Recommended)`.
- If the topic is broad, ask for goal or output shape.
- If only scope is ambiguous, ask about the highest-impact scope field.
- Classify candidate questions as `blocking` or `high-value`.
- Ask blocking questions before generating.
- If no blocking questions remain, ask one concise round of up to 3 high-value questions when answers would materially improve scope, source selection, comparison quality, or output usefulness.
- After one high-value question round, generate with assumptions unless the answer reveals a new blocking gap.
- Ask at most 3 short questions per turn; prefer multiple choice when good defaults exist.
- Do not ask for details that can safely become assumptions or instructions for the research assistant to verify.

Generate when topic and goal/deliverable are known or inferable, local context has been checked or is unavailable, and missing scope can be captured as assumptions. Do not generate when topic is unknown, likely topics conflict, or a missing constraint would materially change sources or evidence comparison.

## Final Prompt Requirements

Write the generated prompt in the user's conversation language unless requested otherwise. Include:

- `Research objective`
- `Context, scope, and assumptions`
- `Research method and source requirements`
- `Output requirements`

The prompt must require authoritative sources, web verification for current or external facts, links near claims, freshness/version/jurisdiction checks, conflict handling, and a clear split between evidence-backed conclusions, assumptions, and uncertainty.

Unless the user asks for another format, require ChatGPT's final answer to be exactly one fenced `markdown` block with no prose outside it. The block must be a copy-ready, self-contained research report, not chat, dialogue, or Q&A. It must restate the problem, avoid context-dependent references such as "above" or "as mentioned", and use these headings when relevant; omit empty or irrelevant sections:

- `Problem`
- `Findings`
- `Evidence`
- `Recommendation`
- `Next Steps`
- `Risks and Verification`

## Compact Template

Adapt this shape to the collected brief:

```text
Complete this research task and return a concise, copy-ready, self-contained research report. Use web search when current or external facts matter.

Research objective:
<Concrete goal.>

Context, scope, and assumptions:
- Context: <Known context, constraints, versions, locale, jurisdiction, audience, exclusions.>
- Local context: <Relevant repository, implementation, docs, tests, config, runtime facts; or "Not available or not relevant.">
- Scope and freshness: <Agreed scope; latest/current, date-bounded, or stable background.>
- Assumptions to verify: <Unknowns to verify.>

Research method:
- Identify the key questions, then verify with official, primary, recent, or authoritative sources.
- For time-sensitive claims, compare dates, versions, jurisdictions, and market coverage.
- Cross-check conclusions, explain credible conflicts, link near claims, and do not fill evidence gaps with guesses.

Output requirements:
- Return exactly one fenced `markdown` block, with no prose outside it.
- Write a copy-ready, self-contained research report, not chat/dialogue/Q&A; restate the problem and avoid references such as "above" or "as mentioned".
- Use clear headings when relevant: Problem, Findings, Evidence, Recommendation, Next Steps, Risks and Verification. Omit empty or irrelevant sections.
- Put links near supported claims; list assumptions, uncertainty, risks, and confirmations needed.
- State unknowns as assumptions, risks, or verification items, not follow-up questions.
- Use a compact comparison table when useful, and end with verification or next steps.
```

Return one short lead-in sentence, then the fenced prompt. Add `Optional context to add` only when helpful but not required.
