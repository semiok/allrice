#!/usr/bin/env python3
"""Bounded 4.0 workday checks. Fixture evidence never grants Dev acceptance."""
import argparse
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
SESSION_ENV = 'ALLRICE_ACCEPTANCE_SESSION'
FIXTURE_FILE = 'apps/worker/src/d-entry/native-entry.fixture.ts'
FIXTURE_SHA = '52daa9b5b0332ec7bf77cdc5a30f81aeefa9b49f'
STEPS = [
    ('GATE.release', 'GATE', '固定组合与节点4开验资格', 'release', '最终组合四门/完整M5/迁移与本人开关批准须由发布负责人核验'),
    ('IDENTITY.login', 'IDENTITY', '本人登录身份', '271', '需要显式测试session与当前本人/企业/员工资格'),
    ('IDENTITY.employee', 'IDENTITY', '选择本人员工及4.0单写者', '271/273', '需要真实4.0 native-owner；3.x/controlReady不等于editorReady/canSend'),
    ('VM.cold', 'VM', '任务VM冷启动与实际ready', '267/273', '冷启首败0/3、物理hardcap/真实receipt未闭合；只读discovery不启动VM'),
    ('VM.warm', 'VM', '已预热任务VM与真实ready', '267/273', '需要真实Host/ready时序与当前owner，不能用controlReady替代'),
    ('CHAT.process', 'CHAT', '原生DSH过程、取消与重连', '273', '生产Host/catalog/current/native-call绑定缺失；本脚本不凭UI文字运行模型'),
    ('SUBAGENT.read', 'SUBAGENT', '子智能体原生列表与只读右栏', '278/271', '需要D owner封版路由/locator与真实Session catalog，保持父会话和草稿'),
    ('SUBAGENT.deny-write', 'SUBAGENT', '服务端拒绝子会话写入', '271', '生产native DataPort未装配；fixture单独检查HTTP拒写，不向Dev子会话试发'),
    ('ATTACHMENT.read', 'ATTACHMENT', '附件上传与实际读取字节', '281/273', '模块许可、精确对象/实际native读取receipt未提供；本地字节不是上传验收'),
    ('REFERENCES.read', 'REFERENCES', '企业资料面板读/预览/引用', '277/281', 'requireCurrentAccess的企业许可/有效配置生产来源未装配'),
    ('REFERENCES.write', 'REFERENCES', '企业资料面板授权写入', '281', '当前模块许可/业务写carrier未封版；不得猜3.x管理API为4.0'),
    ('DELIVERABLES.read', 'DELIVERABLES', '成果面板预览/下载/引用', '277/281', '精确版本/对象权限与真实交付来源未装配'),
    ('DELIVERABLES.write', 'DELIVERABLES', '成果生成/转企业资料', '281', '实际Office/发布receipt与4.0业务carrier缺失，不以Run成功代交付'),
    ('MEMORY.read', 'MEMORY', '记忆面板候选/active读取', '277/283', 'current/actual/stored/adopted/storedSource五reader生产assembly为空'),
    ('MEMORY.write', 'MEMORY', '记忆新增/修改/确认/删除', '283', '真实B/native-call/采用的人类来源/同事务fence缺失，不造写成功'),
    ('CAPABILITIES.read', 'CAPABILITIES', '能力面板与原生目录', '277/285', '可信Host/current/config和实际dispose生产挂载缺失'),
    ('CAPABILITIES.write', 'CAPABILITIES', '能力配置与执行时现权', '285', '企业许可/个人配置producer缺失；catalog不能代执行现权'),
    ('SCHEDULE.native', 'CAPABILITIES', '原生定时创建/执行/记录', '285', '真实Schedule Host/origin/storage/唤醒链未装，不回退3.x scheduler'),
    ('APPROVAL.review', 'APPROVAL', '可信外发冻结内容与审批记录', '270/279', '仅可读可信冻结目标/正文/附件与后台记录；本任务绝不批准或发送'),
    ('APPROVAL.send', 'APPROVAL', '本人审批及外部接收旁证', '270', '真实审批/外发需要另获本人当次授权，本runner不自动执行'),
    ('VM.idle-continue', 'VM', '真实空闲回收后继续同会话', '267/273', '需要真实20分钟与owner恢复证据；不缩时、不杀用户VM、不重放'),
    ('RECOVERY.cold-history', 'RECOVERY', '关机历史只读且不起VM', '274', '冷source/config/checkpoint与附件ACL owner未装配，不能用live startup替代'),
    ('ADMIN.runtime', 'ADMIN', '后台运行状态可读', '279/273', '需要已授权管理员路由与真实运行投影，当前未封版UI locator'),
    ('ADMIN.usage', 'ADMIN', '后台原始用量可读', '279/268', '需要真实上游账本；usage未知必须null，不补0'),
    ('ADMIN.approvals', 'ADMIN', '后台审批记录可读', '279/270', '需要当前权限下真实业务approval/receipt投影'),
    ('INSTRUCTIONS.requests', 'INSTRUCTIONS', '逐父/子实际请求instructions预算', '273/285', '需要固定tokenizer与实际请求hash/四段token，禁止字符估算或均值'),
    ('EGRESS.boundary', 'EGRESS', '真实出口冻结/重绑定/取消', '269', '真实隔离VM及完整producer同binding/fresh-admit证据缺失，本任务不造压'),
    ('MODEL.accounting', 'MODEL', 'OAuth/8路与真实用量/取消', '268', '需要另外授权真实模型与实际上游账本；不运行模型或读取OAuth'),
    ('PERFORMANCE.pairs', 'PERFORMANCE', '冷暖分组AB/BA原始等待', '273/280', '需要同源实际时序与逐对≤1000ms记录，不能从fixture估算'),
    ('VISUAL.matrix', 'VISUAL', 'rev2逐屏亮暗/1440与390对照', '277/278/279', '需要封版页面locator及全部真实运行截图，设计图不是验收截图'),
    ('WORKDAY.human', 'WORKDAY', '本人完整工作日及明确认可', '本人/280', '自动脚本不能授予本人认可；完整工作日尚未开验'),
    ('CLEANUP.live', 'CLEANUP', '实际验收资源回收与保留说明', '各owner', '尚未开验；实际VM/Dev会话不能由本runner擅自关闭'),
]
READ_UI = {'SUBAGENT.read', 'REFERENCES.read', 'DELIVERABLES.read', 'MEMORY.read',
           'CAPABILITIES.read', 'APPROVAL.review', 'RECOVERY.cold-history',
           'ADMIN.runtime', 'ADMIN.usage', 'ADMIN.approvals'}
FIXTURE_IDS = {'IDENTITY.fixture', 'CHAT.fixture', 'SUBAGENT.fixture', 'CLEANUP.fixture'}


class Unavailable(Exception):
    pass


class StopRun(Exception):
    pass


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def scrub(value, secrets=()):
    if isinstance(value, dict):
        return {str(key): ('[REDACTED]' if re.search(
            r'cookie|authorization|password|token|secret|storageState', str(key), re.I)
            else scrub(item, secrets)) for key, item in value.items()}
    if isinstance(value, list):
        return [scrub(item, secrets) for item in value]
    if not isinstance(value, str):
        return value
    for secret in sorted(filter(None, secrets), key=len, reverse=True):
        value = value.replace(secret, '[REDACTED]')
    value = re.sub(r'(?i)(Bearer\s+)\S+', r'\1[REDACTED]', value)
    value = re.sub(r'(?i)((?:cookie|password|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*)[^\s,;]+', r'\1[REDACTED]', value)
    return value


def result(step_id, case, title, status, kind, reason, owner, evidence=(), screenshot=None):
    if status not in {'passed', 'skipped', 'failed'} or kind not in {'dev', 'fixture', 'runner'}:
        raise ValueError('invalid evidence classification')
    return dict(id=step_id, case=case, title=title, status=status, kind=kind,
                reason=reason, owner=owner, evidence=list(evidence), screenshot=screenshot,
                noScreenshotReason=None if screenshot else (
                    '尚未进入真实浏览器：' + reason if status == 'skipped' else
                    '此项是HTTP/本地协议检查，无页面；未启动浏览器截图'))


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, path)


def summarize(steps):
    return dict(counts={state: sum(s['status'] == state for s in steps)
                        for state in ('passed', 'skipped', 'failed')},
                fixturePassed=sum(s['status'] == 'passed' and s['kind'] == 'fixture' for s in steps),
                devPassed=sum(s['status'] == 'passed' and s['kind'] == 'dev' for s in steps),
                completeWorkday=False, acceptanceGranted=False,
                exitCode=1 if any(s['status'] == 'failed' for s in steps) else 2)


def render(receipt):
    esc = lambda text: html.escape(str(text), quote=True)
    rows = []
    for step in receipt['steps']:
        screenshot = step.get('screenshot')
        if screenshot and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.png', screenshot):
            screenshot = None
        media = ('<a href="' + esc(screenshot) + '"><img alt="真实浏览器截图" src="' + esc(screenshot) + '"></a>') if screenshot else esc(step['noScreenshotReason'] or '未获得合法真实截图引用')
        refs = '<br>'.join(esc(ref) for ref in step['evidence']) or '无'
        rows.append('<tr><td>' + esc(step['id']) + '<br>' + esc(step['title']) + '</td><td class="' + esc(step['status']) + '">' + esc(step['status']) + '</td><td>' + esc(step['kind']) + '</td><td>' + esc(step['reason']) + '<br>Owner: ' + esc(step['owner']) + '</td><td>' + refs + '</td><td>' + media + '</td></tr>')
    counts = receipt['summary'].get('counts', {})
    summary = ' / '.join(f'{label} {counts.get(key, 0)}' for key, label in
                         [('passed', '通过'), ('skipped', '跳过'), ('failed', '失败')])
    summary += f" · fixture通过 {receipt['summary'].get('fixturePassed', 0)} · Dev通过 {receipt['summary'].get('devPassed', 0)}"
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'"><title>4.0 工作日验收证据</title><style>body{font:15px/1.55 system-ui;margin:24px;color:#19232e;background:#f5f7fa}h1{font-size:24px}.notice{padding:16px;background:#fff0c2;border:1px solid #ab8700}table{width:100%;border-collapse:collapse;background:white}td,th{border:1px solid #d9e0e7;padding:10px;text-align:left;vertical-align:top;overflow-wrap:anywhere}img{max-width:300px} .passed{color:#176c3b}.failed{color:#a31f25}.skipped{color:#856400}code{overflow-wrap:anywhere}</style><h1>4.0 工作日验收证据</h1><p class="notice">离目标还差：此报告不授予完整工作日通过或本人认可。fixture 通过不是 Dev 验收；skipped 不是 passed。没有截图时显示具体原因。</p><p>模式：''' + esc(receipt['mode']) + ' · 预期release ' + esc(receipt['releaseSha']) + ' · ' + esc(summary) + '</p><table><thead><tr><th>步骤</th><th>结果</th><th>证据来源</th><th>原因 / owner</th><th>证据</th><th>真实截图 / 无截图原因</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table></html>\n'


def offline_bytes(output):
    directory = output / 'fixtures'
    directory.mkdir()
    # Same synthetic input as the original MET280 preparation, not business data.
    files = {'source.txt': 'MET-280 synthetic document. Item A: 3 units. Item B: 5 units.\n',
             'table.csv': 'item,quantity\nA,3\nB,5\n'}
    hashes = {}
    for name, text in files.items():
        path = directory / name
        path.write_text(text)
        if path.read_text() != text:
            raise ValueError('fixture bytes changed')
        hashes[name] = sha(path)
    write_json(output / 'fixture-hashes.json', hashes)
    return result('ATTACHMENT.fixture', 'ATTACHMENT', '既有合成文本/CSV本地字节演练',
                  'passed', 'fixture', '已实际写读并核SHA256；没有上传、对象ACL或工具读取证据',
                  '280', ['fixture-hashes.json'])


def process_env(extra=None):
    # Do not inherit model credentials, DB, proxy, real-Host switches or Node hooks.
    env = {key: os.environ[key] for key in ('PATH', 'TMPDIR', 'SYSTEMROOT') if key in os.environ}
    env['CI'] = '1'
    env.update(extra or {})
    return env


def budget(config, key):
    value = config.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        raise Unavailable('需要操作者显式QA预算: ' + key + '；无产品默认时限')
    return value


def child(args, output, env, config, input_text=None):
    """No shell. On interruption stop and join only this owned process group."""
    timeout = budget(config, 'driverTimeoutSeconds')
    cleanup = budget(config, 'cleanupTimeoutSeconds')
    process = subprocess.Popen(args, stdin=subprocess.PIPE if input_text else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               env=env, cwd=REPO, start_new_session=True)
    try:
        stdout, stderr = process.communicate(input_text, timeout=timeout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        finally:
            try:
                stdout, stderr = process.communicate(timeout=cleanup)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                stdout, stderr = process.communicate()
            (output / 'driver.log').write_text(scrub(stdout + '\n' + stderr,
                                                    [os.environ.get(SESSION_ENV, '')]))
        raise
    # Logs are diagnostics only. The manifest carries validated projections.
    (output / 'driver.log').write_text(scrub(stdout + '\n' + stderr,
                                            [os.environ.get(SESSION_ENV, '')]))
    return process.returncode


def native_fixture(config, output):
    source = Path(config.get('fixtureSource', REPO)).resolve()
    expected = config.get('fixtureSha', FIXTURE_SHA)
    fixture = source / FIXTURE_FILE
    if not fixture.is_file():
        raise Unavailable('273 nativeEntryFixture未在所选源中；配置fixtureSource及精确fixtureSha，不能拷假producer')
    actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != expected:
        raise ValueError('fixture source HEAD differs from fixed fixtureSha')
    if subprocess.run(['git', '-C', str(source), 'diff', '--quiet', 'HEAD'], check=False).returncode != 0:
        raise ValueError('fixture source tree differs from fixed HEAD')
    tracked = subprocess.check_output(['git', '-C', str(source), 'show', f'{actual}:{FIXTURE_FILE}'])
    if hashlib.sha256(tracked).hexdigest() != sha(fixture):
        raise ValueError('fixture source has uncommitted changes')
    vitest = REPO / 'node_modules/vitest/vitest.mjs'
    if not vitest.is_file():
        raise Unavailable('本任务树无已安装vitest依赖；未install/跨树写；由根在受影响门禁执行driver')
    driver_receipt = output / 'native-fixture.json'
    env = process_env({'WORKDAY_FIXTURE_SOURCE': str(source),
                       'WORKDAY_FIXTURE_RECEIPT': str(driver_receipt),
                       'WORKDAY_FIXTURE_CACHE': str(output / '.vitest-cache')})
    code = child([config.get('nodeExecutable', 'node'), str(vitest), 'run',
                  '--config', str(ROOT / 'fixture.config.mjs'), '--maxWorkers=1'], output, env, config)
    if code != 0:
        raise ValueError('native fixture driver failed; sanitized driver.log retained')
    data = json.loads(driver_receipt.read_text())
    if data.get('kind') != 'consumer-fixture' or data.get('closed') is not True:
        raise ValueError('native fixture cleanup/identity receipt incomplete')
    if {step.get('id') for step in data.get('steps', [])} != FIXTURE_IDS:
        raise ValueError('native fixture returned missing/extra steps')
    if len(data['steps']) != len(FIXTURE_IDS):
        raise ValueError('duplicate native fixture steps')
    write_json(output / 'native-source.json', {'sourceSha': actual, 'fixtureSha256': sha(fixture),
                                               'symbol': 'nativeEntryServer/nativeEntryFixture',
                                               'kind': 'consumer-fixture', 'vmOrModel': False})
    return [result(item['id'], item['id'].split('.')[0], item['title'], 'passed',
                   'fixture', item['reason'], '271/273 consumer fixture',
                   ['native-source.json', 'native-fixture.json']) for item in data['steps']]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def validate_live(config):
    if not config.get('baseUrl'):
        raise Unavailable('未配置已获开验授权的Dev origin/本人范围；没有访问共享Dev')
    url = urllib.parse.urlsplit(config['baseUrl'])
    if (url.scheme not in {'https', 'http'} or not url.hostname or url.username or
            url.password or url.path not in {'', '/'} or url.query or url.fragment or
            (url.scheme == 'http' and url.hostname not in {'localhost', '127.0.0.1', '::1'})):
        raise ValueError('explicit HTTPS Dev origin or loopback origin required')
    for key in ('personId', 'organizationId', 'workspaceId', 'employeeInstanceId', 'threadId'):
        if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', config.get(key, '')):
            raise ValueError('explicit authorized scope missing: ' + key)
    gates = config.get('gates', {})
    for key in ('met267', 'node4', 'deployment', 'personalRollout', 'readAuthorization'):
        if not isinstance(gates.get(key), str) or not gates[key].strip():
            raise Unavailable('未交开验前置/批准证据: ' + key + '；配置不是自动批准')
    if not re.fullmatch(r'[0-9a-f]{40}', config.get('releaseSha', '')):
        raise ValueError('fixed deployed releaseSha required')
    if not os.environ.get(SESSION_ENV):
        raise Unavailable('未提供显式测试session；不读取用户浏览器/凭据文件')
    budget(config, 'requestTimeoutSeconds')
    return url.scheme + '://' + url.netloc


def dev_json(origin, route, selection, token, timeout, post=False):
    headers = {'Cookie': 'allrice_session=' + token, 'Origin': origin,
               'Accept': 'application/json', 'Cache-Control': 'no-store'}
    data = None
    if post:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(selection).encode()
    else:
        route += '?' + urllib.parse.urlencode(selection)
    request = urllib.request.Request(origin + route, data=data, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            if response.status != 200:
                raise Unavailable('真实服务返回HTTP ' + str(response.status))
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        # Never persist response headers or an arbitrary error body.
        raise Unavailable('真实入口HTTP ' + str(error.code) + '，无可验证4.0来源') from None


def dev_identity(config, output):
    origin = validate_live(config)
    selection = {key: config[key] for key in ('workspaceId', 'employeeInstanceId', 'threadId')}
    token = os.environ[SESSION_ENV]
    timeout = budget(config, 'requestTimeoutSeconds')
    identity = dev_json(origin, '/api/v1/d-entry/identity', selection, token, timeout)['identity']
    if set(identity) != {'personId', 'organizationId', 'workspaceId', 'employeeInstanceId',
                         'threadId', 'employeeRevision', 'employeeVersionId'}:
        raise ValueError('server identity schema differs; arbitrary fields are not evidence')
    for key in ('personId', 'organizationId', *selection):
        if identity.get(key) != config[key]:
            raise ValueError('server identity differs from authorized person/employee scope')
    owner = dev_json(origin, '/api/v1/d-entry/native-owner', selection, token, timeout, post=True)
    mount = owner.get('mount', {})
    if mount.get('executionGeneration') != '4.0':
        raise Unavailable('服务器不是4.0 mount；不回退3.x作为通过')
    if mount.get('identity') != identity or not mount.get('bindingRef'):
        raise ValueError('native mount identity/binding mismatch')
    # Neither controlReady nor discovery authorizes model input or VM startup.
    write_json(output / 'dev-identity.json', scrub({'identity': identity, 'generation': '4.0',
               'bindingRef': mount['bindingRef'], 'controlReady': owner.get('controlReady'),
               'editorReady': 'not-verified', 'canSend': 'not-verified'}, [token]))
    return [result(step, 'IDENTITY', title, 'passed', 'dev', reason, '271/273', ['dev-identity.json'])
            for step, title, reason in [
                ('IDENTITY.login', '本人登录身份', '真实BFF按显式测试session确认当前本人/企业/员工范围；不是自动登录授权'),
                ('IDENTITY.employee', '选择员工及4.0单写者发现', '实际native-owner返回同identity的4.0 mount；未推断editorReady/canSend')]]


def browser_reads(config, output):
    recipes = config.get('ui', {})
    valid = {}
    for step, recipe in recipes.items():
        if step not in READ_UI or not isinstance(recipe, dict):
            raise ValueError('only named read-only UI recipes are allowed')
        if not all(recipe.get(key) for key in ('ownerSource', 'path', 'locator',
                                               'scopeLocator', 'scopeAttribute')):
            continue
        if not recipe['path'].startswith('/') or recipe['path'].startswith('//') or '..' in recipe['path']:
            raise ValueError('UI route must stay on the authorized Dev origin')
        valid[step] = recipe
    if not valid:
        return []
    executable = config.get('browserExecutable')
    if not executable or not Path(executable).is_absolute() or not Path(executable).is_file():
        raise Unavailable('没有显式已安装的锁定Chromium路径；不下载/不读取用户浏览器资料')
    if not (REPO / 'apps/worker/node_modules/playwright-core').exists():
        raise Unavailable('缺现有Worker playwright-core依赖；未install或启动浏览器')
    binding_ref = json.loads((output / 'dev-identity.json').read_text())['bindingRef']
    payload = {**{key: config[key] for key in ('baseUrl', 'personId', 'organizationId',
               'workspaceId', 'employeeInstanceId', 'threadId')}, 'ui': valid,
               'bindingRef': binding_ref, 'browserExecutable': executable, 'output': str(output)}
    code = child([config.get('nodeExecutable', 'node'), str(ROOT / 'browser.mjs')],
                 output, process_env({SESSION_ENV: os.environ[SESSION_ENV]}), config, json.dumps(payload))
    if code != 0:
        raise ValueError('real browser read/capture/cleanup failed; sanitized driver.log retained')
    data = json.loads((output / 'browser.json').read_text())
    if data.get('closed') is not True or set(data.get('steps', {})) != set(valid):
        raise ValueError('browser result or cleanup incomplete')
    steps = []
    for step, item in data['steps'].items():
        screenshot = item.get('screenshot')
        if screenshot:
            path = (output / screenshot).resolve()
            if (output.resolve() not in path.parents or path.suffix != '.png' or not path.is_file()
                    or not path.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')):
                raise ValueError('invalid browser screenshot artifact')
        if item['status'] == 'passed' and not screenshot:
            raise ValueError('UI pass requires a real browser screenshot')
        row = result(step, step.split('.')[0], step, item['status'], 'dev',
                     item['reason'], valid[step]['ownerSource'], ['browser.json'], screenshot)
        if not screenshot:
            row['noScreenshotReason'] = '真实浏览器未能取得PNG；' + item['reason']
        steps.append(row)
    return steps


def run(mode, output, config):
    # Never replace first failures or previous acceptance artifacts.
    output.mkdir(parents=True, exist_ok=False)
    steps = [result(step, case, title, 'skipped', 'dev', reason, owner)
             for step, case, title, owner, reason in STEPS]
    receipt = {'version': 1, 'mode': mode, 'releaseSha': config.get('releaseSha', 'not-bound'),
               'releaseVerification': '操作者提供的预期SHA；本runner不证明部署/CI/批准真实性',
               'runnerSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
               'caseManifestSha256': sha(ROOT / 'cases.json'), 'startedAt': time.time(),
               'steps': steps, 'caseRequirements': json.loads((ROOT / 'cases.json').read_text())}
    try:
        if mode == 'fixture':
            steps.append(offline_bytes(output))
            try:
                steps.extend(native_fixture(config, output))
            except Unavailable as error:
                steps.append(result('NATIVE.fixture', 'CHAT', '真实consumer fixture入口', 'skipped',
                                    'fixture', str(error), '271/273'))
        else:
            actual = dev_identity(config, output)
            by_id = {item['id']: item for item in actual}
            steps[:] = [by_id.get(step['id'], step) for step in steps]
            try:
                actual = browser_reads(config, output)
            except Unavailable as error:
                actual = [result(step, step.split('.')[0], step, 'skipped', 'dev', str(error),
                                 recipe.get('ownerSource', 'D owner'))
                          for step, recipe in config.get('ui', {}).items() if step in READ_UI]
            by_id = {item['id']: item for item in actual}
            steps[:] = [by_id.get(step['id'], step) for step in steps]
    except Unavailable as error:
        steps.append(result('RUNNER.precondition', 'GATE', '实际开验前置', 'skipped',
                            'dev', str(error), '发布负责人/对应producer owner'))
    except (Exception, KeyboardInterrupt) as error:
        steps.append(result('RUNNER.failure', 'GATE', '执行异常/取消', 'failed', 'runner',
                            type(error).__name__ + ': ' + str(error), '280'))
    finally:
        receipt['finishedAt'] = time.time()
        receipt['summary'] = summarize(steps)
        safe = scrub(receipt, [os.environ.get(SESSION_ENV, '')])
        write_json(output / 'result.json', safe)
        (output / 'index.html').write_text(render(safe))
    return receipt['summary']['exitCode']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['dev', 'fixture'], default='dev')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--config', type=Path)
    args = parser.parse_args()
    def stopped(_signal, _frame):
        raise StopRun('operator stopped this owned runner')
    signal.signal(signal.SIGTERM, stopped)
    try:
        config = json.loads(args.config.read_text()) if args.config else {}
        code = run(args.mode, args.output, config)
        print(json.dumps({'exitCode': code, 'report': str(args.output / 'index.html'),
                          'completeWorkday': False, 'acceptanceGranted': False}))
        return code
    except Exception as error:
        # No tracebacks/config/session values in the public terminal receipt.
        print(json.dumps({'exitCode': 1, 'error': scrub(str(error), [os.environ.get(SESSION_ENV, '')]),
                          'completeWorkday': False}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
