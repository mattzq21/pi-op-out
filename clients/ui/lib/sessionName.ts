export const capSessionName = (name: string) => Array.from(name.trim()).slice(0, 50).join("").trimEnd();
