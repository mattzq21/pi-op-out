const fs = require('node:fs');
(async () => {
  const [source, destination, id] = process.argv.slice(1);
  const output = await fs.promises.open(destination, 'wx', 0o600); let header = Buffer.alloc(0), copiedHeader = false;
  try {
    for await (const chunk of fs.createReadStream(source)) {
      if (copiedHeader) { await output.writeFile(chunk); continue; }
      header = Buffer.concat([header, chunk]); const newline = header.indexOf(10); if (newline < 0) continue;
      const value = JSON.parse(header.subarray(0, newline).toString()); if (value.type !== 'session') throw Error('Invalid session header');
      await output.writeFile(JSON.stringify({ ...value, id, parentSession: source, timestamp: new Date().toISOString() }) + '\n');
      await output.writeFile(header.subarray(newline + 1)); header = undefined; copiedHeader = true;
    }
    if (!copiedHeader) throw Error('Missing session header');
  } catch (error) { await output.close(); await fs.promises.rm(destination, { force: true }); throw error; }
  await output.close();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
