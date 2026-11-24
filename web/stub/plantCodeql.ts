// PLANTED FINDING (AC-DSO-01), never to be merged: request data flows into a shell command.
import { createServer } from 'node:http';
import { exec } from 'node:child_process';

createServer((req, res) => {
  exec('ls ' + (req.url ?? ''));
  res.end();
}).listen(0);
