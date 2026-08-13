# Create a New Figma File

Use the live upstream schema to create a new blank Figma file in the user's drafts folder. This is typically used before creating a `.figma.ts` script for `figma:run`.

## Inputs

The currently observed live schema requires all three inputs. Never invent client-side defaults: read the live schema again before dispatch.

- **planKey**: Destination plan selected in Step 1.
- **editorType**: One of the values accepted by the live schema, currently `design`, `figjam`, or `slides`.
- **fileName**: Non-empty name for the new file.

## Workflow

### Step 1: Confirm the live schema and resolve the planKey

Before an upstream call, run `figma:upstream:list` or `figma:upstream:read` to confirm the live schema for file creation. Use the schema's current tool name and required input fields. Resolve `planKey` from the live identity capability (normally `whoami`) rather than guessing a destination:

1. **User already provided a planKey** (for example, from a previous identity lookup or in their prompt) → use it directly, skip to Step 2.

2. **No planKey available** → read and call the current `whoami` schema through `figma:upstream:call`, then extract the available plan candidates from its actual response.

   - **Single candidate**: use its returned plan key.
   - **Multiple candidates**: ask the user which team or organization they want to create the file in, then use the corresponding returned key.

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
  "planKey": "team::123456",
  "fileName": "My New Design",
  "editorType": "design"
}
```

### Step 3: Use the result

Read the actual response shape. Extract the returned file key and openable URL from that response; their field names are not a stable local contract. Use the returned key as the explicit `--file` value when running a `.figma.ts` script with `figma:run`.

## Important Notes

- The file is created in the user's **drafts folder** for the selected plan.
- Supported editor types are `"design"`, `"figjam"`, and `"slides"`.
- If a mutation is the next step, prepare a `.figma.ts` script and run it with `figma:run`.

## Editor-specific notes

### Slides — newly created files have an empty grid

A `slides` file produced by this tool starts with **zero rows and zero slides** — `figma.getSlideGrid()` returns `[]`, not a default first slide. The page's only child is the `SLIDE_GRID` node itself, which is empty until you create content. The first call to `figma.createSlide()` implicitly creates row 0 and inserts the new slide there.

If your follow-up `.figma.ts` script assumes at least one slide exists (e.g. to read theme tokens off it), guard for the empty case or call `createSlide()` first. See [slide-grid](canonical:figma-use-slides/references/slide-grid.md) for full details.
