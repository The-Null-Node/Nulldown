import React, { useDeferredValue, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import MermaidRenderer from "./MermaidRenderer";
import "katex/dist/katex.min.css";
import { useTheme } from "../theme/themeContext";
import { syntaxThemeStyles } from "../theme/syntaxThemes";
import {
  DEFAULT_IFRAME_ALLOWLIST,
  normalizeIframeAllowlist,
} from "../lib/iframeAllowlist";

export interface MarkdownRenderCallbacks {
  onLinkClick?: (href: string, event: React.MouseEvent<HTMLAnchorElement>) => void;
  onImageClick?: (src: string, event: React.MouseEvent<HTMLImageElement>) => void;
  onCodeRender?: (context: {
    language: string;
    inline: boolean;
    content: string;
  }) => void;
  onBlockedEmbed?: (src: string) => void;
}

export interface MarkdownRendererModule {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  components?: Components;
}

interface EnhancedMarkdownProps {
  children: string;
  className?: string;
  callbacks?: MarkdownRenderCallbacks;
  modules?: readonly MarkdownRendererModule[];
  allowedUrls?: readonly string[];
}

const asList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

const unique = (values: readonly string[]): string[] => Array.from(new Set(values));

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: unique([
    ...asList(defaultSchema.tagNames),
    "iframe",
    "u",
    "ins",
    "sub",
    "sup",
    "mark",
  ]),
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    a: unique([
      ...asList(defaultSchema.attributes?.a),
      "target",
      "rel",
      "title",
    ]),
    iframe: [
      "src",
      "title",
      "width",
      "height",
      "allow",
      "allowfullscreen",
      "loading",
      "referrerpolicy",
      "sandbox",
      "frameborder",
    ],
    u: [...asList(defaultSchema.attributes?.u)],
    ins: [...asList(defaultSchema.attributes?.ins)],
    sub: [...asList(defaultSchema.attributes?.sub)],
    sup: [...asList(defaultSchema.attributes?.sup)],
    mark: [...asList(defaultSchema.attributes?.mark)],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: unique([...(defaultSchema.protocols?.href ?? []), "http", "https", "mailto"]),
    src: unique([...(defaultSchema.protocols?.src ?? []), "https"]),
  },
} as const;

const defaultRemarkPlugins: PluggableList = [remarkGfm, remarkMath as any];
const defaultRehypePlugins: PluggableList = [
  rehypeRaw as any,
  [rehypeSanitize as any, sanitizeSchema],
  rehypeKatex as any,
];

const getTrustedIframeUrl = (rawSrc: string, allowedHosts: Set<string>) => {
  try {
    const parsed = new URL(rawSrc);
    if (parsed.protocol !== "https:") {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    if (!allowedHosts.has(host)) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
};

const mergeModules = (
  baseComponents: Components,
  modules?: readonly MarkdownRendererModule[],
) => {
  if (!modules?.length) {
    return {
      components: baseComponents,
      remarkPlugins: defaultRemarkPlugins,
      rehypePlugins: defaultRehypePlugins,
    };
  }

  return {
    components: modules.reduce(
      (acc, module) => ({
        ...acc,
        ...(module.components ?? {}),
      }),
      baseComponents,
    ),
    remarkPlugins: modules.reduce<PluggableList>(
      (acc, module) => [...acc, ...(module.remarkPlugins ?? [])],
      [...defaultRemarkPlugins],
    ),
    rehypePlugins: modules.reduce<PluggableList>(
      (acc, module) => [...acc, ...(module.rehypePlugins ?? [])],
      [...defaultRehypePlugins],
    ),
  };
};

const EnhancedMarkdown: React.FC<EnhancedMarkdownProps> = React.memo(
  ({
    children,
    className = "prose max-w-none",
    callbacks,
    modules,
    allowedUrls = DEFAULT_IFRAME_ALLOWLIST,
  }) => {
    const { theme } = useTheme();
    const syntaxStyle =
      syntaxThemeStyles[theme.syntax] ?? syntaxThemeStyles.vscDarkPlus;
    const trustedHosts = useMemo(
      () => new Set(normalizeIframeAllowlist(allowedUrls)),
      [allowedUrls],
    );

    const baseComponents = useMemo<Components>(
      () => ({
        table: ({ node, ...props }) => (
          <div className="my-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-border" {...props} />
          </div>
        ),
        thead: ({ node, ...props }) => <thead className="bg-card/60" {...props} />,
        th: ({ node, ...props }) => (
          <th
            className="px-4 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider"
            {...props}
          />
        ),
        td: ({ node, ...props }) => <td className="px-4 py-3 text-sm" {...props} />,
        tr: ({ node, isHeader, ...props }) => (
          <tr className={isHeader ? "" : "border-t border-border"} {...props} />
        ),
        a: ({ node, href, onClick, ...props }) => (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              if (href && callbacks?.onLinkClick) {
                callbacks.onLinkClick(href, event);
              }

              onClick?.(event);
            }}
          />
        ),
        img: ({ node, src, onClick, ...props }) => (
          <img
            {...props}
            src={src}
            loading="lazy"
            onClick={(event) => {
              if (src && callbacks?.onImageClick) {
                callbacks.onImageClick(src, event);
              }

              onClick?.(event);
            }}
          />
        ),
        iframe: ({
          node,
          src,
          title,
          width,
          height,
          allow,
          loading,
          referrerPolicy,
          sandbox,
          ...props
        }) => {
          const rawSrc = typeof src === "string" ? src : "";
          const safeSrc = getTrustedIframeUrl(rawSrc, trustedHosts);

          if (!safeSrc) {
            if (rawSrc && callbacks?.onBlockedEmbed) {
              callbacks.onBlockedEmbed(rawSrc);
            }

            return (
              <div className="my-4 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted">
                Blocked embed from untrusted host.
              </div>
            );
          }

          return (
            <div className="my-4 overflow-hidden rounded-md border border-border">
              <iframe
                {...props}
                src={safeSrc}
                title={typeof title === "string" ? title : "Embedded content"}
                width={typeof width === "string" ? width : "100%"}
                height={typeof height === "string" ? height : "360"}
                allow={typeof allow === "string" ? allow : "fullscreen; encrypted-media"}
                allowFullScreen
                loading={typeof loading === "string" ? loading : "lazy"}
                referrerPolicy={
                  typeof referrerPolicy === "string"
                    ? referrerPolicy
                    : "strict-origin-when-cross-origin"
                }
                sandbox={
                  typeof sandbox === "string"
                    ? sandbox
                    : "allow-scripts allow-same-origin allow-presentation"
                }
                className="aspect-video w-full border-0"
              />
            </div>
          );
        },
        code: ({ node, inline, className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || "");
          const language = match && match[1] ? match[1] : "";
          const content = String(children).replace(/\n$/, "");

          callbacks?.onCodeRender?.({
            language,
            inline: Boolean(inline),
            content,
          });

          if (language === "mermaid") {
            return <MermaidRenderer chart={String(children).trim()} />;
          }

          return !inline && match ? (
            <SyntaxHighlighter
              style={syntaxStyle as any}
              language={language}
              PreTag="div"
              className="rounded-md my-4"
              {...props}
            >
              {content}
            </SyntaxHighlighter>
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }),
      [callbacks, syntaxStyle, trustedHosts],
    );

    const { components, remarkPlugins, rehypePlugins } = useMemo(
      () => mergeModules(baseComponents, modules),
      [baseComponents, modules],
    );

    const deferredMarkdown = useDeferredValue(children);

    return (
      <ReactMarkdown
        className={className}
        remarkPlugins={remarkPlugins as any}
        rehypePlugins={rehypePlugins as any}
        components={components}
      >
        {deferredMarkdown}
      </ReactMarkdown>
    );
  },
);

EnhancedMarkdown.displayName = "EnhancedMarkdown";

export default EnhancedMarkdown;
