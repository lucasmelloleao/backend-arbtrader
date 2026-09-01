import { readFileSync, writeFileSync } from "fs";
import * as crypto from "crypto";
import { join } from "path";

const masterPwd = process.argv[2];

if (!masterPwd) {
  console.error("Uso: npx tsx scripts/crypto-env.ts <MASTER_PASSWORD>");
  process.exit(1);
}

const envPath = join(process.cwd(), ".env");
const encPath = join(process.cwd(), "secrets.enc");

try {
  const envData = readFileSync(envPath, "utf8");
  
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(masterPwd, "salt", 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  
  let encrypted = cipher.update(envData, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const output = `${iv.toString("hex")}:${encrypted}`;
  writeFileSync(encPath, output, "utf8");
  
  console.log("✅ Arquivo .env criptografado com sucesso para secrets.enc!");
  console.log("⚠️ NÃO comite o arquivo .env! Apenas o secrets.enc.");
} catch (e: any) {
  console.error("Erro ao criptografar:", e.message);
}
