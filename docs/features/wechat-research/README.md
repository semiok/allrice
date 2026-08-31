# Cloud WeChat article research

> Status: **MET-96 implemented in the DSH-native Tool and Skill layer**

AllRice can search and read public WeChat Official Account articles without
Rice Bridge. The capability is platform-managed and becomes available only
when an administrator binds the reviewed `wechat-research` Skill and its two
required Tools to an employee revision, then publishes that revision to a
tenant.

## Runtime flow

```text
tenant conversation
  -> frozen Rice employee revision
  -> DSH native Skill: wechat-research
  -> DSH native Tool call
  -> tenant-scoped AllRice Tool Broker
  -> cloud WeChat article service
  -> public metadata / untrusted article text
```

The Tool Broker exposes two read-only, outbound-network Tools:

- `wechat.article.search` searches public articles and returns title, account,
  date, snippet and canonical article URL.
- `wechat.article.read` reads one approved `https://mp.weixin.qq.com/s?...`
  public article and returns normalized metadata, text and image URLs.

DSH receives them as `wechat_article_search` and `wechat_article_read`. Their
call and result lifecycle stays in the native DSH event stream and remains
subject to ChatFlow audit and replay.

## Security boundary

- Only HTTPS requests to the fixed search hosts and public
  `mp.weixin.qq.com/s` article URLs are accepted.
- Redirects are revalidated, response size and request time are bounded, and
  results are cached for short periods.
- Article text is wrapped and marked as untrusted external content. It is
  evidence, never an instruction to the employee.
- Login-only, private, deleted, paywalled and captcha-protected pages are not
  bypassed.
- The service does not expose an arbitrary URL fetcher, Shell, browser session,
  tenant cookie or Rice Bridge command.

The initial implementation uses a cloud HTTP fast path. A future browser-worker
fallback may implement the same fixed Tool contract for pages that require
rendering, but must preserve the allowlist, tenant isolation, bounded execution
and no-captcha-bypass rules. The DSH Skill contract does not change when that
internal implementation changes.

## Publication

Migration `0055` registers `wechat-research` in the platform DSH Skill
registry. It does not silently mutate an already published tenant snapshot.
The platform administrator reviews the Skill, assigns both required Tools to
Rice, runs the existing preview test, and publishes a new immutable employee
revision to Snow or another tenant. Existing Sessions keep their frozen prior
configuration; a new Session receives the new Skill snapshot.

## Verification

- parser and network-boundary tests: `apps/worker/src/wechat-articles.test.ts`
- Tool Broker authorization and normalization tests:
  `apps/worker/src/tool-broker.test.ts`
- DSH protocol and event projection tests under `apps/worker/src/harness`
- source/seed checksum test: `packages/database/src/platform-skills.test.ts`
