import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandKeys } from './commandKeys.ts';

test('unknown outcomes reuse the key; a changed payload or completed action gets a new key', () => {
  const keys = new CommandKeys();
  let counter = 0;
  const create = () => String(++counter);
  assert.equal(keys.begin('candidate:v1:approve', create), '1');
  assert.equal(keys.begin('candidate:v1:approve', create), '1');
  keys.settle('candidate:v1:approve', 503);
  assert.equal(keys.begin('candidate:v1:approve', create), '1');
  assert.equal(keys.begin('candidate:v2:approve', create), '2');
  keys.settle('candidate:v1:approve', 200);
  assert.equal(keys.begin('candidate:v1:approve', create), '3');
  keys.settle('candidate:v1:approve', 409);
  assert.equal(keys.begin('candidate:v1:approve', create), '4');
});
