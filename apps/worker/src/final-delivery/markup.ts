import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { load } from 'cheerio';
import type { DeliveryMarkup } from './policy.js';

/** Same Markdown AST stack as Web; Worker declares its own parser dependencies. */
export function createDeliveryMarkup(): DeliveryMarkup {
  return {
    markdown: (text) =>
      fromMarkdown(text, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      }),
    html: (fragment) => {
      const $ = load(fragment, {}, false);
      return {
        complete: true,
        links: $('a[href],img[src]')
          .toArray()
          .filter(
            (element) => $(element).closest('pre,code,blockquote').length === 0,
          )
          .map((element) => ({
            href: $(element).attr('href') ?? $(element).attr('src')!,
          })),
      };
    },
  };
}
