type FigmaWorkspaceNodeTarget<TNode extends BaseNode = BaseNode> = string | TNode;

interface FigmaWorkspaceTextOptions {
  readonly target?: FigmaWorkspaceNodeTarget<TextNode>;
  readonly parent?: FigmaWorkspaceNodeTarget<BaseNode & ChildrenMixin>;
  readonly text: string;
  readonly font?: FontName;
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

interface FigmaWorkspaceHelpers {
  text(options: FigmaWorkspaceTextOptions): Promise<TextNode>;
  capture(
    target: FigmaWorkspaceNodeTarget<SceneNode>,
    options?: FigmaWorkspaceCaptureOptions,
  ): Promise<FigmaWorkspaceCaptureTicket>;
}

declare const $: Readonly<FigmaWorkspaceHelpers>;
