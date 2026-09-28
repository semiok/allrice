import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { describe, it, expect } from 'vitest';
import {
  BrowserProfileSchema,
  type LocalBrowserProfileBinding,
} from '@allrice/contracts';
import { LocalBrowserProfiles } from './local-browser-profiles.js';

describe.skipIf(process.env.ALLRICE_TEST_LOCAL_BROWSER_NATIVE !== '1')(
  'native browser login reuse',
  () => {
    it('restores Cookies, Local Storage and IndexedDB in a fresh Chromium context', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'allrice-login-'));
      const browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
      });
      try {
        const profiles = new LocalBrowserProfiles(
          join(directory, 'config.json'),
          'https://allrice.example',
        );
        const profile = BrowserProfileSchema.parse({
          version: 1,
          network: 'public_https',
          origins: [],
        });
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
        const first = await browser.newContext();
        await first.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<title>Synthetic login</title>',
          }),
        );
        const page = await first.newPage();
        await page.goto('https://login.example.com');
        await first.addCookies([
          {
            name: 'session',
            value: 'synthetic-cookie',
            domain: 'login.example.com',
            path: '/',
            secure: true,
            httpOnly: true,
          },
        ]);
        await page.evaluate(async () => {
          localStorage.setItem('session', 'synthetic-local');
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open('auth', 1);
            request.onupgradeneeded = () =>
              request.result.createObjectStore('tokens');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const transaction = db.transaction('tokens', 'readwrite');
              transaction
                .objectStore('tokens')
                .put('synthetic-indexed', 'session');
              transaction.oncomplete = () => {
                db.close();
                resolve();
              };
              transaction.onerror = () => reject(transaction.error);
            };
          });
        });
        await profiles.save(
          binding,
          profile,
          await first.storageState({ indexedDB: true }),
        );
        await first.close();
        const second = await browser.newContext({
          storageState: await profiles.load(binding, profile),
        });
        await second.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<title>Next task</title>',
          }),
        );
        const restored = await second.newPage();
        await restored.goto('https://login.example.com');
        expect((await second.cookies())[0]?.value).toBe('synthetic-cookie');
        expect(
          await restored.evaluate(() => localStorage.getItem('session')),
        ).toBe('synthetic-local');
        expect(
          await restored.evaluate(
            () =>
              new Promise((resolve, reject) => {
                const request = indexedDB.open('auth', 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                  const db = request.result;
                  const read = db
                    .transaction('tokens')
                    .objectStore('tokens')
                    .get('session');
                  read.onsuccess = () => {
                    db.close();
                    resolve(read.result);
                  };
                  read.onerror = () => reject(read.error);
                };
              }),
          ),
        ).toBe('synthetic-indexed');
        await second.close();
        await profiles.revoke(binding);
        await expect(profiles.load(binding, profile)).rejects.toThrow(
          'LOCAL_BROWSER_POLICY_DENIED',
        );
      } finally {
        await browser.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000);
  },
);
