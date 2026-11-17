// Read the password on stdin; never pass it as a process argument.
import { hashPassword } from '../dist/auth.js';
let input = '';
for await (const part of process.stdin) input += part;
const password = input.replace(/\r?\n$/, '');
if (!password) throw new Error('Empty password');
process.stdout.write(hashPassword(password) + '\n');
