import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(".dev.vars");
if (existsSync(target)) {
  console.log(".dev.vars 已存在，未覆盖。");
  process.exit(0);
}

const value = () => randomBytes(32).toString("base64url");
const encryptionKey = randomBytes(32).toString("base64");
const body = [
  `ADMIN_API_KEY=${value()}`,
  `GATEWAY_API_KEY=${value()}`,
  `TOKEN_ENCRYPTION_KEY=${encryptionKey}`,
  ""
].join("\n");
writeFileSync(target, body, { encoding: "utf8", flag: "wx" });
console.log("已生成 .dev.vars。密钥未输出；请仅在本机读取该文件。");
