import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('jump action validation requires an explicitly acknowledged modal rather than a sidebar error',()=>{
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8'),dialog=readFileSync(new URL('../app/navigation/jump/validation-dialog.tsx',import.meta.url),'utf8');
  assert.match(page,/error&&<JumpValidationDialog message=\{error\} onConfirm=\{\(\)=>setError\(''\)\}/);
  assert.doesNotMatch(page,/error&&<p className="nav-error" role="alert">\{error\}/);
  assert.match(dialog,/element.showModal\(\)/);assert.match(dialog,/confirm.current\?\.focus\(\)/);
  assert.match(dialog,/role="alertdialog"/);assert.match(dialog,/aria-describedby=\{description\}/);
  assert.match(dialog,/onCancel=\{event=>event.preventDefault\(\)\}/);assert.match(dialog,/onClick=\{onConfirm\}>确认/);
  assert.doesNotMatch(dialog,/onClose=|onClick=\{onConfirm\}.*<h2/);
  assert.match(page,/!error&&!autoBusy&&showCompletion/);assert.match(page,/!error&&!autoBusy&&showDirect/);
  const css=readFileSync(new URL('../app/navigation/jump/jump.css',import.meta.url),'utf8');
  assert.match(css,/\.jump-direct-dialog\.jump-validation-dialog\{width:340px;/);
  assert.match(css,/\.jump-direct-dialog\.jump-validation-dialog footer\{margin-top:16px;padding:0;border:0/);
});
