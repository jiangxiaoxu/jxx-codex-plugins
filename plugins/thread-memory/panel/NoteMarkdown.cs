using System.Globalization;
using System.Net;
using Markdig;
using Markdig.Parsers.Inlines;
using Markdig.Renderers;
using Markdig.Renderers.Html;
using Markdig.Renderers.Html.Inlines;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace ThreadMemoryPanel;

internal static class NoteMarkdown
{
    private static readonly MarkdownPipeline Pipeline = CreatePipeline();

    internal static string Render(string markdown)
    {
        try
        {
            var document = Markdown.Parse(markdown, Pipeline);
            foreach (var heading in document.Descendants<HeadingBlock>())
                heading.Level = Math.Min(heading.Level + 2, 6);

            using var writer = new StringWriter(CultureInfo.InvariantCulture);
            var renderer = new HtmlRenderer(writer);
            Pipeline.Setup(renderer);
            renderer.ObjectRenderers.Replace<LinkInlineRenderer>(new InertLinkRenderer());
            renderer.Render(document);
            return writer.ToString();
        }
        catch (ArgumentException)
        {
            // Markdig rejects notes that exceed its syntax tree nesting limit.
            return "<pre>" + WebUtility.HtmlEncode(markdown) + "</pre>";
        }
    }

    private static MarkdownPipeline CreatePipeline()
    {
        var builder = new MarkdownPipelineBuilder()
            .DisableHtml()
            .UseTaskLists()
            .UseSoftlineBreakAsHardlineBreak();
        builder.InlineParsers.TryRemove<AutolinkInlineParser>();
        return builder.Build();
    }

    private sealed class InertLinkRenderer : HtmlObjectRenderer<LinkInline>
    {
        protected override void Write(HtmlRenderer renderer, LinkInline link)
        {
            renderer.WriteChildren(link);
            if (!string.IsNullOrEmpty(link.Url))
                renderer.Write(" (").WriteEscape(link.Url).Write(')');
        }
    }
}
