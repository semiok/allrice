import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  BrowserProfileSchema,
  type LocalBrowserProfileBinding,
} from '@allrice/contracts';
import {
  startLocalBrowserDriver,
  type LocalBrowserDriver,
} from './local-browser-driver.js';
import { LocalBrowserProfiles } from './local-browser-profiles.js';
const hash = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
describe.skipIf(!process.env.ALLRICE_BROWSER_FIXTURE_STATE)(
  'P22 actual native Chrome and production HTTPS/DNS proxy, owned synthetic fixture only',
  () => {
    it('approves exact real login/upload, delivers download, persists only owned state and actually revokes it', async () => {
      const state = async () =>
        JSON.parse(
          await readFile(process.env.ALLRICE_BROWSER_FIXTURE_STATE!, 'utf8'),
        ) as {
          endpoint: string;
          logins: number;
          uploads: number;
          downloads: number;
          rejected: number;
          stoppedAt: string | null;
        };
      const initial = await state(),
        url = new URL(initial.endpoint);
      if (
        initial.stoppedAt ||
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.trycloudflare.com')
      )
        throw Error('OWNED_FIXTURE_REQUIRED');
      const base = url.origin + url.pathname.replace(/login$/, '');
      const root = await mkdtemp(join(tmpdir(), 'allrice-p22-public-'));
      const profiles = new LocalBrowserProfiles(
        join(root, 'config.json'),
        'https://synthetic-saas.example',
      );
      const binding: LocalBrowserProfileBinding = {
        version: 1,
        scope: {
          organizationId: randomUUID(),
          workspaceId: randomUUID(),
          projectId: null,
        },
        ownerId: randomUUID(),
        deviceId: randomUUID(),
        grantId: randomUUID(),
        grantRevision: 1,
        logicalProfileId: randomUUID(),
        persistLogin: true,
      };
      const profile = BrowserProfileSchema.parse({
        version: 1,
        origins: [url.origin],
        allowHumanCredentials: true,
        allowUploads: true,
        allowDownloads: true,
      });
      const drivers: LocalBrowserDriver[] = [];
      let approvals = 0,
        writes = 0,
        release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const start = async (identity = binding) => {
        const driver = await startLocalBrowserDriver({
          assertAlive: async () => {},
          leaseExpiresAt: () => Date.now() + 4900,
          binding: identity,
          profiles,
          options: {
            profileId: randomUUID(),
            profile,
            assertCurrent: async () => {},
            requestStarted: () => () => {},
            requestSent: () => {
              writes++;
            },
            requestApproval: async (effect) => {
              expect(effect.method).toBe('POST');
              expect([base + 'submit', base + 'upload']).toContain(effect.url);
              expect(effect.urlDigest).toBe(hash(effect.url));
              expect(effect.bodyBytes).toBeGreaterThan(0);
              approvals++;
              if (effect.url === base + 'submit') {
                expect(effect.bodyDigest).toBe(
                  hash(
                    'username=P21-synthetic&password=P21-Synthetic-Password',
                  ),
                );
                await pending;
              }
              return { complete: async () => {} };
            },
          },
        });
        drivers.push(driver);
        return driver;
      };
      try {
        const driver = await start();
        const observe = async () => (await driver.observe(1)).observation;
        await driver.perform({ type: 'navigate', url: initial.endpoint }, null);
        let observation = await observe();
        await driver.perform(
          {
            type: 'fill',
            elementId: observation.elements.find(
              (element) => element.label === 'Username',
            )!.id,
            value: 'P21-synthetic',
          },
          observation,
        );
        observation = await observe();
        const password = Buffer.from('P21-Synthetic-Password');
        await driver.perform(
          {
            type: 'sensitive_fill',
            elementId: observation.elements.find(
              (element) => element.sensitive,
            )!.id,
            inputId: randomUUID(),
          },
          observation,
          password,
        );
        expect(password.every((byte) => byte === 0)).toBe(true);
        observation = await observe();
        expect(JSON.stringify(observation)).not.toContain(
          'P21-Synthetic-Password',
        );
        await driver.perform(
          {
            type: 'click',
            elementId: observation.elements.find(
              (element) => element.tag === 'button',
            )!.id,
          },
          observation,
        );
        for (let i = 0; i < 80 && approvals === 0; i++) await delay(50);
        expect(approvals).toBe(1);
        expect(writes).toBe(0);
        expect((await state()).logins).toBe(initial.logins);
        release();
        for (let i = 0; i < 100; i++) {
          await delay(100);
          observation = await observe();
          if (observation.text.includes('Signed in:')) break;
        }
        expect(observation.text).toContain('Signed in: P21 synthetic');
        expect((await state()).logins).toBe(initial.logins + 1);
        const upload = Buffer.from('P21-synthetic-upload');
        await driver.perform(
          {
            type: 'upload',
            elementId: observation.elements.find(
              (element) => element.inputType === 'file',
            )!.id,
            objectId: randomUUID(),
            checksum: hash(upload),
            fileName: 'p22.txt',
          },
          observation,
          upload,
        );
        upload.fill(0);
        observation = await observe();
        await driver.perform(
          {
            type: 'click',
            elementId: observation.elements.find(
              (element) => element.tag === 'button',
            )!.id,
          },
          observation,
        );
        for (
          let i = 0;
          i < 100 && (await state()).uploads === initial.uploads;
          i++
        )
          await delay(100);
        expect((await state()).uploads).toBe(initial.uploads + 1);
        observation = await observe();
        const download = await driver.perform(
          {
            type: 'download',
            elementId: observation.elements.find(
              (element) => element.label === 'Download synthetic file',
            )!.id,
          },
          observation,
        );
        expect(download.download?.bytes.toString()).toBe(
          'P21-synthetic-download',
        );
        download.download?.bytes.fill(0);
        expect((await state()).downloads).toBe(initial.downloads + 1);
        expect(approvals).toBe(2);
        expect(writes).toBe(2);
        await driver.checkpoint();
        await driver.close('lost');
        const reopened = await start();
        await reopened.perform({ type: 'navigate', url: base + 'home' }, null);
        expect((await reopened.observe(2)).observation.text).toContain(
          'Signed in: P21 synthetic',
        );
        await reopened.close('revoked');
        await profiles.revoke(binding);
        await expect(start()).rejects.toThrow('LOCAL_BROWSER_UNAVAILABLE');
        const privateRecord = await readFile(
          join(
            profiles.deviceDirectory(binding.deviceId),
            `${binding.logicalProfileId}.json`,
          ),
          'utf8',
        );
        expect(JSON.parse(privateRecord).state).toBeNull();
        expect(privateRecord).not.toContain('P21-Synthetic-Password');
        const fresh = await start({
          ...binding,
          grantId: randomUUID(),
          logicalProfileId: randomUUID(),
          persistLogin: false,
        });
        await expect(
          fresh.perform({ type: 'navigate', url: base + 'home' }, null),
        ).rejects.toThrow();
        expect((await state()).rejected).toBe(initial.rejected + 1);
      } finally {
        release();
        const closed = await Promise.allSettled(
          drivers.map((driver) => driver.close('lost')),
        );
        await rm(root, { recursive: true });
        expect(closed.every((result) => result.status === 'fulfilled')).toBe(
          true,
        );
      }
    }, 90000);
  },
);
