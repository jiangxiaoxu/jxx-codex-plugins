# Create semantic tokens

Create a small, reviewed batch of semantic Figma variables that aliases existing primitive variables in each named mode. Each semantic token receives specific scopes and Web code syntax, keeping it usable in property pickers and Dev Mode without duplicating raw values.

## Prerequisites and inputs

- Create the target collection and its modes first, and create the primitive variables to be referenced.
- Inspect local variables and replace every `TODO` placeholder with actual collection names, primitive names, CSS syntax, and approved token definitions.
- Provide the primitive collection ID from the external ledger for every alias. A primitive name alone is not a sufficient recovery identity.
- Primitive targets must be local to the same Figma file and have the same resolved type as the semantic variable.
- Save this file as `C:/work/project/figma-scripts/create-semantic-tokens.figma.ts`.

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
      "TODO: Light": { collectionId: "VariableCollectionId:PRIMITIVES", name: "TODO: blue/500" },
      "TODO: Dark": { collectionId: "VariableCollectionId:PRIMITIVES", name: "TODO: blue/400" },
    },
    scopes: ["FRAME_FILL", "SHAPE_FILL"],
    webCodeSyntax: "TODO: var(--color-bg-primary)",
  },
] as const;

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const collectionMatches = collections.filter((candidate) => candidate.name === collectionName);
if (collectionMatches.length !== 1) {
  throw new Error(`Expected exactly one local variable collection named \"${collectionName}\", found ${collectionMatches.length}.`);
}
const collection = collectionMatches[0];

const localVariables = await figma.variables.getLocalVariablesAsync();
const modeIdByName = new Map(collection.modes.map((mode) => [mode.name, mode.modeId]));

for (const token of tokens) {
  if (localVariables.some((variable) =>
    variable.variableCollectionId === collection.id && variable.name === token.name,
  )) {
    throw new Error(`Variable \"${token.name}\" already exists in \"${collectionName}\".`);
  }

  for (const [modeName, primitiveIdentity] of Object.entries(token.aliases)) {
    const primitiveMatches = localVariables.filter((variable) =>
      variable.variableCollectionId === primitiveIdentity.collectionId
      && variable.name === primitiveIdentity.name,
    );
    if (!modeIdByName.has(modeName)) {
      throw new Error(`Mode \"${modeName}\" is not present in \"${collectionName}\".`);
    }
    if (primitiveMatches.length !== 1) {
      throw new Error(`Expected one primitive named \"${primitiveIdentity.name}\" in its recorded collection, found ${primitiveMatches.length}.`);
    }
    const primitive = primitiveMatches[0];
    if (primitive.resolvedType !== token.type) {
      throw new Error(`Primitive \"${primitiveIdentity.name}\" has type ${primitive.resolvedType}, expected ${token.type}.`);
    }
  }
}

const created: Array<{ name: string; id: string }> = [];
for (const token of tokens) {
  const semantic = figma.variables.createVariable(token.name, collection, token.type);
  semantic.scopes = [...token.scopes];
  semantic.setVariableCodeSyntax("WEB", token.webCodeSyntax);

  for (const [modeName, primitiveIdentity] of Object.entries(token.aliases)) {
    const modeId = modeIdByName.get(modeName);
    const primitiveMatches = localVariables.filter((variable) =>
      variable.variableCollectionId === primitiveIdentity.collectionId
      && variable.name === primitiveIdentity.name,
    );
    if (!modeId || primitiveMatches.length !== 1) {
      throw new Error("Token validation unexpectedly lost a required mode or exact primitive identity.");
    }
    semantic.setValueForMode(modeId, figma.variables.createVariableAlias(primitiveMatches[0]));
  }

  created.push({ name: semantic.name, id: semantic.id });
}

return { collectionId: collection.id, created, count: created.length };
```

## Run explicitly

After replacing every placeholder and reviewing aliases, scopes, and code syntax, save and run the local `.figma.ts` file. The example is not automatically executable.

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

Validate the returned IDs and inspect the collection afterward. Confirm that every alias resolves, every semantic token has targeted scopes, and the Web syntax matches the actual codebase token name.
