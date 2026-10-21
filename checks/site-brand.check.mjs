import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('browser title and sidebar use the same Serenity Toolbox name',()=>{
  const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');
  assert.match(source('../app/layout.tsx'),/title: "晨曦工具箱"/);
  assert.match(source('../app/tool-sidebar.tsx'),/<b>晨曦工具箱<\/b><small>SERENITY TOOLBOX<\/small>/);
  assert.match(source('../README.md'),/^# 晨曦工具箱 · V/);
});
