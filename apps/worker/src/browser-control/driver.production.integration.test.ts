import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import {
  BrowserProfileSchema,
  type BrowserObservation,
} from '@allrice/contracts';
import { startBrowserControlDriver } from './driver.js';
const suite = process.env.ALLRICE_BROWSER_FIXTURE_STATE
  ? describe.sequential
  : describe.skip;
const hash = (b: string | Buffer) =>
  'sha256:' + createHash('sha256').update(b).digest('hex');
suite(
  'P21 public HTTPS production pinned proxy, isolated Chromium, synthetic fixture only',
  () => {
    it('real login gates exact POST, keeps cookies profile-scoped, uploads and downloads real HTTPS bytes', async () => {
      const statePath = process.env.ALLRICE_BROWSER_FIXTURE_STATE!;
      const state = async () =>
        JSON.parse(await readFile(statePath, 'utf8')) as {
          endpoint: string;
          logins: number;
          uploads: number;
          downloads: number;
          rejected: number;
          stoppedAt: string | null;
        };
      const initial = await state(),
        url = new URL(initial.endpoint),
        base = url.origin + url.pathname.replace(/login$/, ''),
        origin = url.origin;
      if (
        initial.stoppedAt ||
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.trycloudflare.com')
      )
        throw Error('OWNED_FIXTURE_REQUIRED');
      let release!: () => void;
      const pending = new Promise<void>((r) => {
        release = r;
      });
      let requests = 0;
      let clicking: Promise<unknown> | undefined;
      const driver = await startBrowserControlDriver({
        profileId: randomUUID(),
        profile: BrowserProfileSchema.parse({
          version: 1,
          origins: [origin],
          allowHumanCredentials: true,
          allowUploads: true,
          allowDownloads: true,
        }),
        assertCurrent: async () => {},
        requestSent: () => {},
        requestStarted: () => () => {},
        requestApproval: async (effect) => {
          expect(effect.method).toBe('POST');
          expect([base + 'submit', base + 'upload']).toContain(effect.url);
          expect(effect.urlDigest).toBe(hash(effect.url));
          expect(effect.bodyBytes).toBeGreaterThan(0);
          requests++;
          if (effect.url === base + 'submit') {
            expect(effect.bodyDigest).toBe(
              hash('username=P21-synthetic&password=P21-Synthetic-Password'),
            );
            expect((await state()).logins).toBe(initial.logins);
            await pending;
          }
          return { complete: async () => {} };
        },
      });
      const observe = async (): Promise<BrowserObservation> =>
        (await driver.observe(1)).observation;
      try {
        await driver.perform({ type: 'navigate', url: initial.endpoint }, null);
        let o = await observe();
        await driver.perform(
          {
            type: 'fill',
            elementId: o.elements.find((e) => e.label === 'Username')!.id,
            value: 'P21-synthetic',
          },
          o,
        );
        o = await observe();
        const secret = Buffer.from('P21-Synthetic-Password');
        await driver.perform(
          {
            type: 'sensitive_fill',
            elementId: o.elements.find((e) => e.sensitive)!.id,
            inputId: randomUUID(),
          },
          o,
          secret,
        );
        expect(secret.every((b) => b === 0)).toBe(true);
        o = await observe();
        expect(JSON.stringify(o)).not.toContain('P21-Synthetic-Password');
        let clickFinished = false;
        clicking = driver
          .perform(
            {
              type: 'click',
              elementId: o.elements.find((e) => e.tag === 'button')!.id,
            },
            o,
          )
          .finally(() => {
            clickFinished = true;
          });
        void clicking.catch(() => undefined);
        for (let i = 0; i < 80 && requests === 0; i++) await delay(50);
        expect(requests).toBe(1);
        expect(clickFinished).toBe(false);
        expect((await state()).logins).toBe(initial.logins);
        release();
        await clicking;
        for (let i = 0; i < 100; i++) {
          await delay(100);
          o = await observe();
          if (o.text.includes('Signed in')) break;
        }
        expect(o.text).toContain('Signed in: P21 synthetic');
        expect((await state()).logins).toBe(initial.logins + 1);
        const upload = Buffer.from('P21-synthetic-upload');
        await driver.perform(
          {
            type: 'upload',
            elementId: o.elements.find((e) => e.inputType === 'file')!.id,
            objectId: randomUUID(),
            checksum: hash(upload),
            fileName: 'p21.txt',
          },
          o,
          upload,
        );
        o = await observe();
        await driver.perform(
          {
            type: 'click',
            elementId: o.elements.find((e) => e.tag === 'button')!.id,
          },
          o,
        );
        for (
          let i = 0;
          i < 100 && (await state()).uploads === initial.uploads;
          i++
        )
          await delay(100);
        expect((await state()).uploads).toBe(initial.uploads + 1);
        o = await observe();
        const download = await driver.perform(
          {
            type: 'download',
            elementId: o.elements.find(
              (e) => e.label === 'Download synthetic file',
            )!.id,
          },
          o,
        );
        expect(download.download?.bytes.toString()).toBe(
          'P21-synthetic-download',
        );
        expect(download.download?.name).toBe('p21-synthetic.txt');
        expect((await state()).downloads).toBe(initial.downloads + 1);
        expect(requests).toBe(2);
        const second = await startBrowserControlDriver({
          profileId: randomUUID(),
          profile: BrowserProfileSchema.parse({
            version: 1,
            origins: [origin],
          }),
          assertCurrent: async () => {},
          requestStarted: () => () => {},
          requestApproval: async () => {
            throw Error('NO_APPROVAL');
          },
          requestSent: () => {
            throw Error('NO_WRITE');
          },
        });
        try {
          await expect(
            second.perform({ type: 'navigate', url: base + 'home' }, null),
          ).rejects.toThrow('ERR_HTTP_RESPONSE_CODE_FAILURE');
          expect((await state()).rejected).toBe(initial.rejected + 1);
        } finally {
          await second.close();
        }
      } finally {
        release();
        await driver.close();
        await clicking?.catch(() => undefined);
      }
    }, 90000);
  },
);
