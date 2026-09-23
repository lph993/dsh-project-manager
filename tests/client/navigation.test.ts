/**
 * 右栏文件跳转缝的契约测试。
 *
 * 地址格式是**官方契约**（`dsh-api-workspace-files` 的 `dsh-resource://file/session/<id>/<路径>`），
 * 拼错一个字符的后果是"点了没反应"，所以这里把编码、分隔符、以及**拒绝绝对路径**都钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fileAddress,
  hasResourceOpener,
  openWorkspaceFile,
  setResourceOpener,
} from '../../src/client/navigation.ts';

test('文件地址：会话作用域 + 工作区相对路径', () => {
  assert.equal(
    fileAddress('s1', 'src/client/api.ts'),
    'dsh-resource://file/session/s1/src/client/api.ts',
  );
});

test('文件地址：路径段逐段编码（空格/中文/井号都不能漏）', () => {
  assert.equal(
    fileAddress('s1', 'docs/立 项.md'),
    'dsh-resource://file/session/s1/docs/%E7%AB%8B%20%E9%A1%B9.md',
  );
  // `#` / `?` 在地址里是片段/查询分隔符，段内必须被编码，否则会被解析截断
  assert.equal(
    fileAddress('s1', 'a#b?.ts'),
    'dsh-resource://file/session/s1/a%23b%3F.ts',
  );
});

test('文件地址：Windows 反斜杠与重复分隔符归一化', () => {
  assert.equal(fileAddress('s1', 'src\\client\\\\api.ts'), 'dsh-resource://file/session/s1/src/client/api.ts');
});

test('文件地址：绝对路径 / 空值一律拒绝（会话地址解析不到它们）', () => {
  assert.equal(fileAddress('s1', 'C:/tmp/x.ts'), undefined);
  assert.equal(fileAddress('s1', '/etc/passwd'), undefined);
  assert.equal(fileAddress('s1', '\\\\server\\share\\x.ts'), undefined);
  assert.equal(fileAddress('s1', '   '), undefined);
  assert.equal(fileAddress('', 'src/a.ts'), undefined);
  assert.equal(fileAddress(undefined, 'src/a.ts'), undefined);
});

test('打开：没有 opener 时如实回 no-opener，不假装成功', () => {
  setResourceOpener(undefined);
  assert.equal(hasResourceOpener(), false);
  assert.equal(openWorkspaceFile('s1', 'src/a.ts'), 'no-opener');
});

test('打开：有 opener 时把地址原样交出去', () => {
  const seen: string[] = [];
  setResourceOpener((address) => seen.push(address));
  assert.equal(hasResourceOpener(), true);
  assert.equal(openWorkspaceFile('s1', 'src/a.ts'), 'opened');
  assert.deepEqual(seen, ['dsh-resource://file/session/s1/src/a.ts']);
  setResourceOpener(undefined);
});

test('打开：opener 抛错算 failed（官方对无类型认领的地址会抛）', () => {
  setResourceOpener(() => {
    throw new Error('no type claims it');
  });
  assert.equal(openWorkspaceFile('s1', 'src/a.ts'), 'failed');
  setResourceOpener(undefined);
});
