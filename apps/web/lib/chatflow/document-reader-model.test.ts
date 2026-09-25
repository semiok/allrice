import { describe, expect, it } from 'vitest';
import {
  isToolResultExport,
  isToolResultFile,
  searchResultDocument,
} from './document-reader-model';

describe('document reader data', () => {
  it('identifies stored tool responses without hiding similarly named documents', () => {
    const objectId = '00000000-0000-4000-8000-000000000001';
    const fileName = `tool-result-web-search-${objectId}.txt`;
    expect(isToolResultFile(fileName, objectId)).toBe(true);
    expect(
      isToolResultExport({
        fileName,
        objectId,
        changeSummary: `Tool result web.search; Run run-1; call call-1`,
      }),
    ).toBe(true);
    expect(
      isToolResultExport({ fileName, objectId, changeSummary: null }),
    ).toBe(false);
    expect(
      isToolResultExport({
        fileName: 'tool-result-web-search-notes.txt',
        objectId,
        changeSummary: 'Research notes',
      }),
    ).toBe(false);
  });
  it('unwraps actual search output and keeps source links without making up content', () => {
    expect(
      searchResultDocument(
        JSON.stringify({
          provider: 'test',
          query: '发布消息',
          output:
            '[官方公告](https://example.com/news)\n实际摘录citeturn0search0 [wordlim: 200]',
        }),
      ),
    ).toEqual({
      query: '发布消息',
      body: '[官方公告](https://example.com/news)\n实际摘录 ',
    });
    expect(searchResultDocument('plain text')).toBeNull();
    expect(searchResultDocument('{"query":"x","output":{}}')).toBeNull();
  });
});
