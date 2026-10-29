export const capSessionName = (name: string) => Array.from(name.replace(/\s+/g, " ").trim()).slice(0, 50).join("").trimEnd();
