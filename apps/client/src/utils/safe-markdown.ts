import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { sanitizeUrl } from './safe-html';

const ALLOWED_MARKDOWN_TAGS = [
    'a',
    'blockquote',
    'br',
    'code',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'ul',
];

const ALLOWED_MARKDOWN_ATTRS = ['href', 'title'];

function toHtml(markdown: string): string {
    return marked.parse(markdown, {
        async: false,
        breaks: true,
    }) as string;
}

function sanitizeRenderedMarkdown(markdown: string): string {
    return DOMPurify.sanitize(toHtml(markdown), {
        ALLOWED_TAGS: ALLOWED_MARKDOWN_TAGS,
        ALLOWED_ATTR: ALLOWED_MARKDOWN_ATTRS,
    });
}

export function replaceMarkdownContent(container: Element, markdown: string | null | undefined): void {
    container.replaceChildren();

    const safeMarkdown = markdown?.trim();
    if (!safeMarkdown) {
        return;
    }

    const template = container.ownerDocument.createElement('template');
    template.innerHTML = sanitizeRenderedMarkdown(safeMarkdown);

    template.content.querySelectorAll('a').forEach((anchor) => {
        const safeHref = sanitizeUrl(anchor.getAttribute('href'));
        if (!safeHref) {
            anchor.removeAttribute('href');
            return;
        }

        anchor.setAttribute('href', safeHref);
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.setAttribute('target', '_blank');
    });

    container.replaceChildren(template.content.cloneNode(true));
}
