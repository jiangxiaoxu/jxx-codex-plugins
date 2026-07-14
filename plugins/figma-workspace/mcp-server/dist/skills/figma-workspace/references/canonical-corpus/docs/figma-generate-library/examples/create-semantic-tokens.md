# Create semantic tokens

Create a small, reviewed batch of semantic Figma variables that aliases existing primitive variables in each named mode. Each semantic token receives specific scopes and Web code syntax, keeping it usable in property pickers and Dev Mode without duplicating raw values.

## Prerequisites and inputs

- Create the target collection and its modes first, and create the primitive variables to be referenced.
- Inspect local variables and replace every `TODO` placeholder with actual collection names, primitive names, CSS syntax, and approved token definitions.
- Primitive targets must be local to the same Figma file and have the same resolved type as the semantic variable.
- Save this file as `C:/work/project/.figma-workspace/create-semantic-tokens.figma.ts`.

## Safety boundary

The script validates the target collection, its modes, and every primitive alias before creating anything. It stops if a token name already exists in the collection, preventing duplicate variables. It creates only the listed semantic variables, never mutates primitive values, and intentionally avoids `ALL_SCOPES`. Review the token list and CSS names before running; this is an example, not an automatic migration.

## Script

```typescript
const collectionName = "TODO: Color";

const tokens = [
  {
    name: "TODO: color/bg/primary",
    type: "COLOR",
    aliases: {
      "TODO: Light": "TODO: blue/500",
      "TODO: Dark": "TODO: blue/400",
    },
    scopes: ["FRAME_FILL", "SHAPE_FILL"],
    webCodeSyntax: "TODO: var(--color-bg-primary)",
  },
] as const;

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const collection = collections.find((candidate) => candidate.name === collectionName);
if (!collection) {
  throw new Error(`Local variable collection \"${collectionName}\" was not found.`);
}

const localVariables = await figma.variables.getLocalVariablesAsync();
const variableByName = new Map(localVariables.map((variable) => [variable.name, variable]));
const modeIdByName = new Map(collection.modes.map((mode) => [mode.name, mode.modeId]));

for (const token of tokens) {
  if (localVariables.some((variable) =>
    variable.variableCollectionId === collection.id && variable.name === token.name,
  )) {
    throw new Error(`Variable \"${token.name}\" already exists in \"${collectionName}\".`);
  }

  for (const [modeName, primitiveName] of Object.entries(token.aliases)) {
    const primitive = variableByName.get(primitiveName);
    if (!modeIdByName.has(modeName)) {
      throw new Error(`Mode \"${modeName}\" is not present in \"${collectionName}\".`);
    }
    if (!primitive) {
      throw new Error(`Primitive variable \"${primitiveName}\" was not found.`);
    }
    if (primitive.resolvedType !== token.type) {
      throw new Error(`Primitive \"${primitiveName}\" has type ${primitive.resolvedType}, expected ${token.type}.`);
    }
  }
}

const created: Array<{ name: string; id: string }> = [];
for (const token of tokens) {
  const semantic = figma.variables.createVariable(token.name, collection, token.type);
  semantic.scopes = [...token.scopes];
  semantic.setVariableCodeSyntax("WEB", token.webCodeSyntax);

  for (const [modeName, primitiveName] of Object.entries(token.aliases)) {
    const modeId = modeIdByName.get(modeName);
    const primitive = variableByName.get(primitiveName);
    if (!modeId || !primitive) {
      throw new Error("Token validation unexpectedly lost a required mode or primitive.");
    }
    semantic.setValueForMode(modeId, figma.variables.createVariableAlias(primitive));
  }

  created.push({ name: semantic.name, id: semantic.id });
}

return { collectionId: collection.id, created, count: created.length };
```

## Run explicitly

After replacing every placeholder and reviewing aliases, scopes, and code syntax, save and run the local `.figma.ts` file. The example is not automatically executable.

```powershell
@'
{
  "scriptPath": "C:/work/project/.figma-workspace/create-semantic-tokens.figma.ts",
  "surface": "design",
  "strict": true
}
'@ | npm --silent run figma:script:run -- --input - --state-file C:/work/project/.figma-workspace/state.json
```

Validate the returned IDs and inspect the collection afterward. Confirm that every alias resolves, every semantic token has targeted scopes, and the Web syntax matches the actual codebase token name.
