# Create a New Figma File

Use the live upstream schema to create a new blank Figma file in the user's drafts folder. This is typically used before creating a `.figma.ts` script for `figma:script:run`.

## Inputs

- **editorType**: `design` (default), `figjam`, or `slides`
- **fileName**: Name for the new file (defaults to "Untitled")

Examples:
- Omitted values create a design file named "Untitled"
- `figjam`, "My Whiteboard" creates a FigJam file named "My Whiteboard"
- `design`, "My New Design" creates a design file named "My New Design"
- `slides`, "Q3 Review" creates a Slides presentation named "Q3 Review"

If editorType is not provided, default to `"design"`. If fileName is not provided, default to `"Untitled"`.

## Workflow

### Step 1: Confirm the live schema and resolve the planKey

Before an upstream call, run `figma:upstream:list` or `figma:upstream:read` to confirm the live schema for file creation. Use the schema's current tool name and required input fields. The current capability normally requires a `planKey`; follow this decision tree:

1. **User already provided a planKey** (for example, from a previous identity lookup or in their prompt) → use it directly, skip to Step 2.

2. **No planKey available** → use `figma:upstream:call` for the identity capability confirmed by the live schema. The response contains a `plans` array. Each plan has a `key`, `name`, `seat`, and `tier`.

   - **Single plan**: use its `key` field automatically.
   - **Multiple plans**: ask the user which team or organization they want to create the file in, then use the corresponding plan's `key`.

### Step 2: Call the confirmed upstream capability

Call `figma:upstream:call` with the live-schema tool name and its required input:

| Parameter    | Required | Description |
|-------------|----------|-------------|
| `planKey`   | Yes      | The plan key from Step 1 |
| `fileName`  | Yes      | Name for the new file |
| `editorType`| Yes      | `"design"`, `"figjam"`, or `"slides"` |

Example:
```json
{
  "planKey": "team:123456",
  "fileName": "My New Design",
  "editorType": "design"
}
```

### Step 3: Use the result

The tool returns:
- `file_key` — the key of the newly created file
- `file_url` — a direct URL to open the file in Figma

Use the returned `file_key` when opening a workspace session and running a `.figma.ts` script with `figma:script:run`.

## Important Notes

- The file is created in the user's **drafts folder** for the selected plan.
- Supported editor types are `"design"`, `"figjam"`, and `"slides"`.
- If a mutation is the next step, prepare a `.figma.ts` script and run it with `figma:script:run`.

## Editor-specific notes

### Slides — newly created files have an empty grid

A `slides` file produced by this tool starts with **zero rows and zero slides** — `figma.getSlideGrid()` returns `[]`, not a default first slide. The page's only child is the `SLIDE_GRID` node itself, which is empty until you create content. The first call to `figma.createSlide()` implicitly creates row 0 and inserts the new slide there.

If your follow-up `.figma.ts` script assumes at least one slide exists (e.g. to read theme tokens off it), guard for the empty case or call `createSlide()` first. See [slide-grid](../figma-use-slides/references/slide-grid.md) for full details.
