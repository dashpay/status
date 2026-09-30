import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('host probe handles malformed wire data without running host commands on import', () => {
  execFileSync('python3', ['-m','unittest','discover','-s','agent','-p','test_probe.py'], {timeout:10000});
});
