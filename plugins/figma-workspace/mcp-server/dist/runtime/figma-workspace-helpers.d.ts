type FigmaWorkspaceNodeLike = { readonly id: string };
type FigmaWorkspaceTarget = string | FigmaWorkspaceNodeLike;
type FigmaWorkspaceNodeTarget = FigmaWorkspaceTarget | readonly FigmaWorkspaceTarget[];

type FigmaWorkspacePaintInput = SolidPaint | ImagePaint | readonly Paint[];
type FigmaWorkspacePositionInput = {
  readonly x?: number;
  readonly y?: number;
};
type FigmaWorkspaceSizeInput = {
  readonly width?: number;
  readonly height?: number;
};
type FigmaWorkspaceFontInput = FontName & {
  readonly size?: number;
};
type FigmaWorkspaceAppearanceInput = {
  readonly fills?: FigmaWorkspacePaintInput;
  readonly strokes?: readonly Paint[];
  readonly opacity?: number;
  readonly cornerRadius?: number;
};

interface FigmaWorkspaceTextOptions {
  readonly target?: FigmaWorkspaceTarget;
  readonly text?: string | number | boolean;
  readonly parent?: FigmaWorkspaceTarget;
  readonly as?: string;
  readonly font?: FigmaWorkspaceFontInput;
  readonly fontFamily?: string;
  readonly fontStyle?: string;
  readonly name?: string;
  readonly appearance?: FigmaWorkspaceAppearanceInput;
  readonly position?: FigmaWorkspacePositionInput;
  readonly size?: FigmaWorkspaceSizeInput;
}

interface FigmaWorkspaceCheckpointOptions {
  readonly depth?: number;
}

interface FigmaWorkspaceCaptureOptions {
  readonly imageFile?: string;
  readonly maxDimension?: number;
  readonly contentsOnly?: boolean;
}

interface FigmaWorkspaceCaptureTicket {
  readonly requestId: string;
  readonly nodeId: string;
}

interface FigmaWorkspaceNodeSummary {
  readonly id?: string;
  readonly type?: string;
  readonly name?: string;
  readonly visible?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly locked?: boolean;
  readonly layoutMode?: string;
  readonly layoutPositioning?: string;
  readonly characters?: string;
  readonly children?: readonly FigmaWorkspaceNodeSummary[];
}

interface FigmaWorkspaceSelectionResult {
  readonly selectedNodeIds: readonly string[];
  readonly summaries: readonly FigmaWorkspaceNodeSummary[];
}

interface FigmaWorkspaceSelectOptions {
  readonly allowEmpty?: boolean;
  readonly zoom?: boolean;
  readonly depth?: number;
}

interface FigmaWorkspaceCheckpointResult {
  readonly name: string;
  readonly handles: Readonly<Record<string, string>>;
  readonly summaries: readonly (FigmaWorkspaceNodeSummary | readonly FigmaWorkspaceNodeSummary[] | null)[];
}

interface FigmaWorkspaceFindFreeSlotOptions {
  readonly parent?: FigmaWorkspaceTarget;
  readonly preferred?: FigmaWorkspacePositionInput;
  readonly position?: FigmaWorkspacePositionInput;
  readonly size?: Required<FigmaWorkspaceSizeInput>;
  readonly gap?: number;
  readonly direction?: "right" | "left" | "up" | "down";
  readonly exclude?: FigmaWorkspaceTarget;
}

interface FigmaWorkspacePlacementResult {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly shiftedSlots: number;
  readonly collidedNodeIds: readonly string[];
}

interface FigmaWorkspacePlaceNodeOptions extends FigmaWorkspaceFindFreeSlotOptions {
  readonly avoidOverlap?: boolean;
  readonly as?: string;
}

interface FigmaWorkspaceReplaceGeneratedFrameOptions {
  readonly name: string;
  readonly guardPrefix?: string;
  readonly parent?: FigmaWorkspaceTarget;
  readonly size?: Required<FigmaWorkspaceSizeInput>;
  readonly position?: FigmaWorkspacePositionInput;
  readonly placement?: FigmaWorkspacePlaceNodeOptions;
  readonly as?: string;
  readonly select?: boolean;
  readonly zoom?: boolean;
  readonly depth?: number;
}

interface FigmaWorkspaceReplaceGeneratedFrameResult {
  readonly replaced: readonly string[];
  readonly frame: FigmaWorkspaceNodeSummary | null;
  readonly selectedNodeIds: readonly string[];
  readonly handle?: string;
}

interface FigmaWorkspaceImageAssetOptions {
  readonly target?: FigmaWorkspaceTarget;
  readonly parent?: FigmaWorkspaceTarget;
  readonly base64?: string;
  readonly bytes?: Uint8Array | readonly number[];
  readonly name?: string;
  readonly size?: Required<FigmaWorkspaceSizeInput>;
  readonly position?: FigmaWorkspacePositionInput;
  readonly scaleMode?: "FILL" | "FIT" | "CROP" | "TILE";
  readonly fit?: "FILL" | "FIT" | "CROP" | "TILE";
  readonly opacity?: number;
  readonly as?: string;
}

interface FigmaWorkspaceCloneNodeTreeOptions {
  readonly source?: FigmaWorkspaceTarget;
  readonly target?: FigmaWorkspaceTarget;
  readonly parent?: FigmaWorkspaceTarget;
  readonly name?: string;
  readonly position?: FigmaWorkspacePositionInput;
  readonly offset?: FigmaWorkspacePositionInput;
  readonly placement?: "right" | "left" | "above" | "below" | "none";
  readonly gap?: number;
  readonly preserveInstanceSubtrees?: boolean;
  readonly select?: boolean;
  readonly zoom?: boolean;
  readonly depth?: number;
  readonly as?: string;
}

interface FigmaWorkspaceCloneNodeTreeResult {
  readonly source: FigmaWorkspaceNodeSummary | null;
  readonly clone: FigmaWorkspaceNodeSummary | null;
  readonly copiedNodeCount: number;
  readonly order: readonly {
    readonly depth: number;
    readonly sourceId: string;
    readonly sourceName?: string;
    readonly sourceType?: string;
    readonly cloneId: string;
  }[];
  readonly fallbackWholeSubtrees: readonly {
    readonly sourceId: string;
    readonly sourceName?: string;
    readonly sourceType?: string;
    readonly cloneId: string;
    readonly reason: string;
  }[];
  readonly selectedNodeIds: readonly string[];
  readonly handle?: string;
}

interface FigmaWorkspaceDollar {
  (target: "$currentPage"): Promise<PageNode>;
  (target: "$selection"): Promise<SceneNode[]>;
  (target: FigmaWorkspaceTarget): Promise<BaseNode>;
  readonly handles: Readonly<Record<string, string>>;
  remember(handle: string, target: FigmaWorkspaceTarget): string;
  forget(handle: string): void;
  resolveId(target: FigmaWorkspaceTarget): string;
  node(target: FigmaWorkspaceTarget): Promise<BaseNode>;
  select(targets?: FigmaWorkspaceNodeTarget, options?: FigmaWorkspaceSelectOptions): Promise<FigmaWorkspaceSelectionResult>;
  text(options: FigmaWorkspaceTextOptions): Promise<TextNode>;
  text(target: FigmaWorkspaceTarget, text: string, options?: FigmaWorkspaceTextOptions): Promise<TextNode>;
  findFreeSlot(options?: FigmaWorkspaceFindFreeSlotOptions): Promise<FigmaWorkspacePlacementResult>;
  placeNode(target: FigmaWorkspaceTarget, options?: FigmaWorkspacePlaceNodeOptions): Promise<FigmaWorkspacePlacementResult>;
  replaceGeneratedFrame(options: FigmaWorkspaceReplaceGeneratedFrameOptions): Promise<FigmaWorkspaceReplaceGeneratedFrameResult>;
  imageAsset(options: FigmaWorkspaceImageAssetOptions): Promise<SceneNode>;
  inspect(target: FigmaWorkspaceTarget, depth?: number): Promise<FigmaWorkspaceNodeSummary | readonly FigmaWorkspaceNodeSummary[] | null>;
  capture(target: FigmaWorkspaceTarget, options?: FigmaWorkspaceCaptureOptions): Promise<FigmaWorkspaceCaptureTicket>;
  cloneNodeTree(target: FigmaWorkspaceTarget, options?: FigmaWorkspaceCloneNodeTreeOptions): Promise<FigmaWorkspaceCloneNodeTreeResult>;
  cloneNodeTree(options: FigmaWorkspaceCloneNodeTreeOptions): Promise<FigmaWorkspaceCloneNodeTreeResult>;
  checkpoint(name: string, targets?: FigmaWorkspaceNodeTarget, options?: FigmaWorkspaceCheckpointOptions): Promise<FigmaWorkspaceCheckpointResult>;
  readonly checkpoints: readonly FigmaWorkspaceCheckpointResult[];
}

declare const $: FigmaWorkspaceDollar;
