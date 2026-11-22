import { createHash } from 'node:crypto';

export const referenceStyleBoundaryId = 'pinned-rev2-surface-style-v1';
export const referenceDocumentSelector =
  '[data-panels-reference-document="pinned-rev2-public-slot-v1"]';
const body = '[data-panels-reference-body]';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const rawIdentities = {
  globals: '3493206a01188bb0c4ad32c7481c1cd17c1462da796b441908aa468c3f314669',
  components:
    'd59114f7892cb8c28c933c2683bd2c1896ce436c7d728cf9b82896ab9267199e',
};
const groups = new Set([
  '@media(max-width:760px)',
  '@supports not selector(::-webkit-scrollbar)',
  '@container employee_capability_presentation_employee-capabilities (max-width: 440px)',
  '@media(hover:none),(pointer:coarse)',
  '@media(max-width:1100px)',
  '@media(max-width:520px)',
  '@media(max-width:600px)',
  '@media(max-width:640px)',
  '@media(max-width:700px)',
  '@media(max-width:700px),(pointer:coarse)',
  '@media(min-width:701px)and (pointer:fine)',
  '@media(min-width:761px)',
  '@media(prefers-reduced-motion:reduce)',
  '@starting-style',
]);
// These are CSS-only names in fixed 4c, not JS style/property references.
// Named definitions are document-wide even inside @scope, so isolate both
// declarations and every CSS use without changing the original artifacts.
const names = {
  '--allrice-workbench-offset': '--reference-rev2-workbench-offset',
  employee_skills_host_spin: 'reference_rev2_employee_skills_host_spin',
};
const rename = (value: string) =>
  Object.entries(names).reduce(
    (result, [from, to]) => result.replaceAll(from, to),
    value,
  );

/** A closed codec for these two fixed compiled snapshots, not a CSS loader.
 * Rules keep their original declaration bytes and order. Only document
 * selectors are projected onto unboxed owners; original viewport rules have
 * no meaning inside a native pane. @scope also contains every class/pseudo. */
export function projectReferenceStyleSnapshot(
  css: string,
  artifact: 'globals' | 'components',
) {
  const mappings: {
    artifact: string;
    offset: number;
    originalRuleSha256: string;
    originalSelector: string;
    outputSelector: string | null;
    context: string[];
    policy: string;
  }[] = [];
  const projectSelector = (selector: string) => {
    // :is(tag,:where(owner)) keeps the original tag's specificity. The scope
    // excludes the actual document root; the owner alternative matches here.
    const result = selector.replace(
      /(^|,)\s*(:root|html|body)(?=[\s.[\]:>+~,#]|$)/g,
      (_match, prefix: string, name: string) =>
        prefix +
        `:is(${name},:where(${name === 'body' ? body : referenceDocumentSelector}))${name === 'body' ? '' : ':where(:scope)'}`,
    );
    if (/(?:^|[\s,>+~])(?:html|body)(?=[\s.[\]:>+~,#]|$)/.test(result))
      throw Error('Unmapped reference document selector: ' + selector);
    return result === '[data-allrice-framework=v2]'
      ? ':where(:scope)' + result
      : result;
  };
  // These are the complete viewport-only rules in the fixed global artifact,
  // from 4c apps/web/app/styles/base.css. No declaration is silently filtered.
  const viewport = new Map([
    [
      'html{min-height:100%;overflow-y:scroll;scrollbar-gutter:stable}',
      'original-html-viewport',
    ],
    ['body{margin:0;min-height:100%}', 'original-body-viewport'],
  ]);
  const omitted = new Set<string>();
  const consume = (start: number, end: number, context: string[]): string => {
    let output = '',
      cursor = start;
    while (cursor < end) {
      while (/\s/.test(css[cursor] ?? '') && cursor < end) cursor++;
      if (cursor === end) break;
      const offset = cursor;
      let quote = '',
        escaped = false,
        open = -1,
        close = -1,
        depth = 0;
      for (; cursor < end; cursor++) {
        const ch = css[cursor]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (quote) {
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '{') {
          if (!depth) open = cursor;
          depth++;
        }
        if (ch === '}' && --depth === 0) {
          close = cursor++;
          break;
        }
      }
      if (open < offset || close < open || quote || depth)
        throw Error('Unrecognized fixed reference CSS rule');
      const selector = css.slice(offset, open).trim();
      const rule = css.slice(offset, close + 1);
      if (selector.startsWith('@')) {
        if (
          artifact === 'components' &&
          [
            '@keyframes employee_skills_host_spin{to{transform:rotate(360deg)}}',
            '@property --allrice-workbench-offset{syntax: "<length>"; inherits: true; initial-value: 0px;}',
          ].includes(rule)
        ) {
          mappings.push({
            artifact,
            offset,
            originalRuleSha256: hash(rule),
            originalSelector: selector,
            outputSelector: rename(selector),
            context,
            policy: 'same-named-definition-with-reference-only-css-name',
          });
          output += rename(rule);
          continue;
        }
        if (!groups.has(selector) || context.length > 1)
          throw Error('Unrecognized reference CSS group: ' + selector);
        output +=
          selector +
          '{' +
          consume(open + 1, close, [...context, selector]) +
          '}';
        continue;
      }
      if (
        !selector ||
        selector.includes('/*') ||
        css.slice(open + 1, close).includes('{')
      )
        throw Error('Unrecognized fixed reference CSS selector');
      const viewportPolicy =
        artifact === 'globals' ? viewport.get(rule) : undefined;
      if (viewportPolicy) omitted.add(viewportPolicy);
      const outputSelector = viewportPolicy ? null : projectSelector(selector);
      mappings.push({
        artifact,
        offset,
        originalRuleSha256: hash(rule),
        originalSelector: selector,
        outputSelector,
        context,
        policy:
          viewportPolicy ??
          (rename(rule) === rule
            ? 'same-declarations-inside-owned-scope'
            : 'same-declarations-with-reference-only-css-names'),
      });
      if (outputSelector !== null)
        output += outputSelector + rename(css.slice(open, close + 1));
    }
    return output;
  };
  const projected = consume(0, css.length, []);
  if (artifact === 'globals' && omitted.size !== viewport.size)
    throw Error('Fixed reference viewport rules are missing or changed');
  return { projected, mappings };
}

export function derivePinnedReferenceStyle(
  globals: string,
  components: string,
) {
  for (const [name, css] of Object.entries({ globals, components }))
    if (hash(css) !== rawIdentities[name as keyof typeof rawIdentities])
      throw Error('Unrecognized pinned reference CSS snapshot: ' + name);
  const globalRules = projectReferenceStyleSnapshot(globals, 'globals');
  const componentRules = projectReferenceStyleSnapshot(
    components,
    'components',
  );
  // The only added native paint inputs, proven by official rc.2 ui-theme
  // corner-shape.css and client/web/base.css versus the fixed old HTML/UA.
  // initial is the old UA behavior, not values read from the actual product.
  const boundary = `:where(:scope){display:contents;--dsw-corner-shape:initial;-webkit-font-smoothing:initial;-moz-osx-font-smoothing:initial;text-autospace:initial}:where(${body}){display:contents}:where(:scope,:scope::before,:scope::after,:scope *,:scope *::before,:scope *::after){corner-shape:initial}`;
  const surface = `@scope (${referenceDocumentSelector}){${boundary}${globalRules.projected}${componentRules.projected}}`;
  const rules =
    JSON.stringify(
      {
        id: referenceStyleBoundaryId,
        pinnedHead: '4c2e1069e087e645365100850756afe742c35e3d',
        rawArtifacts: rawIdentities,
        cssNames: names,
        sourceMapping:
          'Offsets and rule hashes refer to the separately preserved, exact fixed-source compiled CSS artifacts; their complete git source closure is in carrier metadata.',
        ownerRules: {
          'display:contents':
            'Test-only public slot root/body owners are unboxed; native Host owns viewport and pane geometry.',
          'corner-shape:initial;--dsw-corner-shape:initial':
            'Old fixed globals/UA have round corners and no corner token; new official ui-theme corner-shape.css adds the noninherited universal rule.',
          '-webkit-font-smoothing:initial;-moz-osx-font-smoothing:initial;text-autospace:initial':
            'Old globals/UA and historical reference DOM; new official client/web/base.css body adds these inherited declarations.',
        },
        rules: [...globalRules.mappings, ...componentRules.mappings],
        surfaceSha256: hash(surface),
      },
      null,
      2,
    ) + '\n';
  return { surface, rules };
}
