export const capSessionName = (name: string) => Array.from(name.replace(/\s+/g, " ").trim()).slice(0, 50).join("").trimEnd();

/** A user prompt as the chat list shows it: each leading skill block becomes "$name". */
export const promptTitle = (prompt: string) => prompt.replace(/^(?:\s*<skill\b[^>]*>[\s\S]*?<\/skill>\s*)+/, blocks => [...blocks.matchAll(/<skill\b[^>]*\bname="([^"]*)"/g)].map(match => `$${match[1]} `).join("")).trim();
