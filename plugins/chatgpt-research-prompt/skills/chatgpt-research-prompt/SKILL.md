---
name: chatgpt-research-prompt
description: "Generate copy-ready ChatGPT prompts for research, investigation, or exploration. Use when invoked as $chatgpt-research-prompt or when turning a question into a research prompt."
---

# ChatGPT Research Prompt

## Mission

Generate exactly one paste-ready prompt for Web ChatGPT / Deep Research.

The generated prompt must be self-contained. It must include the research objective, the inferred problem direction, relevant chat context, user confirmations, and all local repository/environment facts needed for Web ChatGPT to produce an accurate research report without seeing the user's local files, terminal, screenshots, attachments, previous messages, or hidden context.

Do not perform the external/web research task yourself. Use local inspection only to collect and compress the brief for another ChatGPT instance that has web access but no local environment access.

## Trigger Rule

Use this skill only when the user explicitly invokes `$chatgpt-research-prompt` or explicitly asks to use this skill.

Do not trigger it merely because the user mentions research, investigation, exploration, comparison, web search, prompt writing, or Deep Research.

## Non-Negotiable Deliverable

After enough information has been collected, return exactly one fenced `text` code block. The content inside the block must be the complete prompt the user will paste into Web ChatGPT / Deep Research.

Do not add a lead-in sentence, commentary, analysis, summary, or optional notes outside the fenced block.

The generated prompt must not depend on hidden context or context-dependent references. Avoid phrases such as "above", "as mentioned", "this repo", "the current implementation", "the attached file", or "my local files" unless the relevant details are explicitly restated inside the generated prompt.

Assume the receiving Web ChatGPT knows nothing about:

- the user's previous messages;
- the local machine or terminal;
- repository name, root path, branch, file tree, dependencies, configs, docs, tests, or implementation;
- uploaded files, screenshots, logs, errors, or attachments;
- tool outputs or local search results.

## Workflow

1. Infer the research direction from the skill invocation, the current user request, and relevant chat context.
2. Before asking non-blocking questions, inspect available local context in a read-only way when local files/tools are available.
3. Extract known brief fields from chat, user confirmations, and local context.
4. Decide whether any user question is necessary.
5. Ask only blocking or high-value confirmation questions that materially improve the final prompt.
6. Generate the final prompt once the topic and goal are known or inferable and local context has been checked or explicitly unavailable.

## Use of `request_user_input`

Preserve user confirmation when it matters.

When a question is needed, prefer `request_user_input` if available and allowed. If it is unavailable, ask concise plain-text questions.

Use `request_user_input` when one or more of these is true:

- the research topic is missing;
- multiple incompatible research directions are plausible;
- the desired decision, deliverable, or success criterion is ambiguous enough to change source selection or evaluation criteria;
- a missing constraint would materially change the research, such as jurisdiction, market, target platform, production environment, framework version, license, budget, security posture, risk tolerance, compatibility requirement, or output format;
- local reconnaissance finds conflicting clues and the user must choose the intended direction;
- the generated prompt may include sensitive-adjacent local details and the user should confirm inclusion or exclusion.

Question policy:

- Ask after local reconnaissance unless the research topic itself is unknown.
- Ask all blocking questions before generating.
- If no blocking questions remain, ask at most one concise round of up to three high-value questions.
- Prefer multiple-choice questions when useful, and mark the best inferred option as `(Recommended)`.
- Treat the user's answer as part of the self-contained context that must be included in the final prompt.
- After one high-value question round, generate with explicit assumptions unless the answer reveals a new blocking ambiguity.
- Do not ask for details that can be discovered locally or safely listed as assumptions, unknowns, or verification items.

## Local Reconnaissance Protocol

When local files or terminal access are available, perform scoped, read-only reconnaissance before drafting the prompt.

Start broad, then narrow:

- Identify the working directory and repository root if possible.
- Inspect top-level files and directories.
- Check git metadata when available: branch name, dirty status, recent changed files, and remote repository name if non-sensitive.
- Read relevant manifests, dependency files, and configs, such as `package.json`, lockfiles, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`, `pom.xml`, `build.gradle`, `Dockerfile`, `docker-compose.yml`, `tsconfig.json`, framework configs, CI configs, README files, and docs.
- Search for terms from the user request and inferred problem direction using available local search tools such as `rg`, file search, IDE search, or equivalents.
- Inspect relevant source files, tests, docs, entrypoints, API routes, components, services, migrations, schemas, scripts, and configuration.
- If errors, stack traces, logs, screenshots, or command output are present in chat or files, capture the relevant excerpt and source.

Keep exploration proportional. Do not scan huge generated or dependency directories such as `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `.venv`, `coverage`, vendor directories, or cache directories unless the user specifically asks.

Use local commands only when read-only and helpful for the prompt. Do not modify files, install packages, run destructive commands, run migrations, start long-running services, or perform the external/web research task.

If local file access is unavailable, state that limitation inside the generated prompt and include only chat-derived context.

## Local Context Extraction Requirements

Capture enough local information for Web ChatGPT to reason as if briefed by a local engineer. Prefer concise summaries over long pasted files, but include exact snippets when semantics matter.

Collect these fields when available:

- Project/repository identity: repository name, root path if useful, branch, package manager, language, framework, runtime, deployment target, and relevant versions.
- User request: exact user goal, inferred research direction, and explicit constraints.
- Existing implementation: what exists, where it lives, how pieces connect, what behavior currently occurs, and what is missing or problematic.
- Relevant files inspected: exact paths plus concise relevance notes.
- Important code/config details: APIs, functions, classes, types, routes, commands, dependency versions, feature flags, environment variable names, schemas, tests, errors, logs, and snippets relevant to the research.
- Constraints and non-goals: platform, stack, compatibility requirements, security/privacy requirements, performance constraints, UX/product constraints, deployment/runtime assumptions, and exclusions.
- Unknowns: facts not available locally that Web ChatGPT should verify through research.
- Evidence quality: whether each local fact comes from code, config, docs, tests, logs, screenshots, terminal output, or user statements.

Redact secrets, credentials, tokens, cookies, private keys, passwords, personal data, and sensitive endpoint values. Include variable names, config keys, dependency names, and non-sensitive paths when useful, but never secret values.

## Completeness Checklist Before Final Output

Before returning the final fenced `text` block, ensure the generated prompt contains concrete information for all relevant items below. Do not leave generic placeholders such as `<...>`. If a field is unknown, write `Unknown; verify during research` or `Not available from local inspection`.

The generated prompt should include:

- the research objective;
- why the research is needed;
- the user's actual request and relevant prior chat context;
- confirmations collected from `request_user_input`, if any;
- local inspection status: inspected, unavailable, or intentionally skipped;
- repository/project identity and stack;
- exact relevant file paths and why they matter;
- current implementation summary and how related files connect;
- relevant versions, dependencies, configs, commands, tests, errors, logs, or snippets;
- constraints, non-goals, and assumptions;
- unknowns and facts to verify externally;
- concrete research questions;
- source quality requirements;
- required report structure.

## Generated Prompt Requirements

The generated prompt is for Web ChatGPT / Deep Research. It must instruct the receiving model to use web search or deep research when current, external, version-specific, standards-related, legal, pricing, product, library, framework, vendor, or ecosystem facts matter.

The generated prompt must include these sections, adapted to the task:

- `Research objective`
- `Why this research is needed`
- `Self-contained context from chat and user confirmations`
- `Local repository and environment context`
- `Relevant local files and existing implementation`
- `Research questions`
- `Research method and source requirements`
- `Output requirements`
- `Known assumptions, unknowns, and verification items`

The generated prompt must require Web ChatGPT / Deep Research to:

- treat the included local context as the only available local/project context;
- not assume access to local files, screenshots, previous chat messages, attachments, or hidden state;
- verify external/current facts using authoritative and recent sources;
- prefer official documentation, specifications, standards, vendor docs, release notes, changelogs, source repositories, issue trackers, reputable engineering writeups, academic papers, and vendor docs as appropriate;
- compare source dates, versions, jurisdictions, markets, and compatibility with the local stack;
- put source links near the claims they support;
- cross-check important claims across multiple credible sources when possible;
- explain conflicts between credible sources;
- distinguish evidence-backed conclusions from assumptions, uncertainties, and local verification items;
- produce practical recommendations that account for the local implementation and constraints;
- include risks, tradeoffs, and concrete verification steps.

## Prompt Template

Adapt this template to the collected brief. Replace every placeholder with concrete information. Remove irrelevant sections, but never remove self-containment.

```text
You are Web ChatGPT / Deep Research. Complete the following research task and return a self-contained, evidence-backed research report.

You do not have access to my local repository, files, terminal, screenshots, attachments, previous messages, or hidden context. Treat the local context included in this prompt as the complete local/project brief. If something is missing, identify it as an assumption, uncertainty, or verification item instead of inventing details.

Research objective:
<Concrete objective: what needs to be researched, decided, compared, explained, planned, verified, or recommended.>

Why this research is needed:
<The practical decision, implementation problem, debugging goal, architecture choice, product question, compatibility concern, or learning goal.>

Self-contained context from chat and user confirmations:
<User request, relevant prior chat context, confirmations collected through request_user_input, constraints, preferred language, target audience, output preferences, and explicit exclusions. Do not refer to unstated conversation history.>

Local repository and environment context:
<Repository/project identity, root path if useful, branch/status if useful, language/framework/runtime/package manager, relevant versions, deployment assumptions, config facts, and local inspection limitations. If local inspection was unavailable, say so explicitly.>

Relevant local files and existing implementation:
<For each relevant file, include exact path and concise relevance summary. Include important functions/classes/routes/types/config values/dependency versions/tests/errors/logs/snippets when needed. Summarize current behavior, wiring, and gaps. Do not paste secrets.>

Research questions:
<Numbered questions the research should answer. Include comparison targets, decision criteria, compatibility questions, best practices, risks, migration paths, implementation implications, or verification needs.>

Research method and source requirements:
- Use web search/deep research for current, external, version-specific, ecosystem, standard, pricing, policy, legal, library, framework, vendor, or product facts.
- Prefer official documentation, specifications, standards, release notes, changelogs, source repositories, issue trackers, reputable engineering writeups, academic papers, and vendor docs as appropriate.
- Check source dates, versions, jurisdiction/market applicability, and compatibility with the local stack described above.
- Put links near the claims they support.
- Cross-check important claims across multiple credible sources when possible.
- Explain conflicts between credible sources instead of hiding them.
- Separate evidence-backed conclusions from assumptions, uncertainties, and items that require local verification.

Output requirements:
- Return exactly one fenced `markdown` block and no prose outside it.
- Write a copy-ready, self-contained research report, not a dialogue or Q&A.
- Restate the problem in the report.
- Do not refer to hidden context, previous messages, attached files, local files, or "the current code" unless their relevant details are included in this prompt.
- Use clear sections appropriate to the task, such as: Problem, Local Context, Findings, Evidence, Options, Recommendation, Implementation Notes, Risks and Tradeoffs, Verification Steps, Next Steps.
- Include compact comparison tables when useful.
- Give a clear recommendation when evidence supports one; otherwise explain what information is still needed to decide.
- End with concrete verification steps or next actions.

Known assumptions, unknowns, and verification items:
<Assumptions made while generating this brief, local facts that could not be inspected, external facts that must be verified, and risks that depend on environment/version/jurisdiction.>
```
