export const capSessionName = (name: string) => Array.from(name.trim()).slice(0, 30).join("").trimEnd();
