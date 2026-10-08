import { spawnSync } from "node:child_process";
import { link, open, readFile, rm } from "node:fs/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";

const ownerSchema = Type.Object({ pid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) });

const lockedSchema = Type.Object({ ownership: Type.Literal("flock") });

const tokenSchema = Type.Object({ token: Type.String() });

const fileErrorSchema = Type.Object({ code: Type.String() });

type ChannelOwnership = { pid: number | undefined; token: string | undefined; locked: boolean };

function channelBusy(path: string) {
  return Object.assign(new Error("Subagent usage channel is already owned"), { code: "EEXIST", path });
}

async function lockChannel(path: string) {
  const file = await open(`${path}.lock`, "a", 0o600);

  try {
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", file.fd], timeout: 5000 });

    if (result.error) throw result.error;

    if (result.status === 1) throw channelBusy(path);

    if (result.status !== 0) throw new Error(`Subagent usage lock failed: ${result.stderr.toString().trim() || result.signal || result.status}`);

    return file;
  } catch (error) { await file.close(); throw error; }
}

async function readChannel(path: string): Promise<ChannelOwnership | undefined> {
  try {
    const channel = JSON.parse(await readFile(path, "utf8"));

    return { pid: Check(ownerSchema, channel) ? channel.pid : undefined, token: Check(tokenSchema, channel) ? channel.token : undefined, locked: Check(lockedSchema, channel) };
  }
  catch (error) {
    if (error instanceof SyntaxError || (Check(fileErrorSchema, error) && error.code === "ENOENT")) return;

    throw error;
  }
}

async function reclaimChannel(path: string) {
  const channel = await readChannel(path);

  if (channel?.pid && !channel.locked) {
    try { process.kill(channel.pid, 0); }
    catch (error) {
      if (!Check(fileErrorSchema, error) || error.code !== "ESRCH") throw error;

      await rm(path, { force: true });

      return;
    }

    throw channelBusy(path);
  }

  await rm(path, { force: true });
}

async function removeChannel(path: string, token: string) {
  const channel = await readChannel(path);

  if (channel?.token === token) await rm(path, { force: true });
}

async function writeChannel(path: string, port: number, token: string) {
  const file = await open(path, "wx", 0o600);

  try {
    await file.writeFile(JSON.stringify({ ownership: "flock", usageProtocol: 2, port, token, pid: process.pid }));
    await file.sync();
  } finally { await file.close(); }
}

export async function claimUsageChannel(path: string, port: number, token: string) {
  const lock = await lockChannel(path);
  let published = false;
  let released: Promise<void> | undefined;

  const release = () => released ??= (async () => {
    try { if (published) await removeChannel(path, token); }
    finally { await lock.close(); }
  })();

  try {
    await reclaimChannel(path);
    const temporary = `${path}.tmp`;
    await rm(temporary, { force: true });

    try {
      await writeChannel(temporary, port, token);
      await link(temporary, path);
      published = true;
    } finally { await rm(temporary, { force: true }); }

    return release;
  } catch (error) { await release(); throw error; }
}
