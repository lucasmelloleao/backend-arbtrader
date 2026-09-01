import { readFileSync } from "fs";
import * as crypto from "crypto";
import * as dotenv from "dotenv";
import { join } from "path";

export function loadEnv() {
  const masterPwd = process.env.MASTER_PASSWORD;
  
  if (masterPwd) {
    try {
      const encPath = join(process.cwd(), "secrets.enc");
      const enc = readFileSync(encPath, "utf8");
      
      const [ivHex, encryptedData] = enc.split(":");
      const iv = Buffer.from(ivHex, "hex");
      const key = crypto.scryptSync(masterPwd, "salt", 32);
      
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      let decrypted = decipher.update(encryptedData, "hex", "utf8");
      decrypted += decipher.final("utf8");
      
      const config = dotenv.parse(decrypted);
      for (const k in config) {
        if (process.env[k] === undefined) {
          process.env[k] = config[k];
        }
      }
      console.log("🔒 Segredos carregados em memória via secrets.enc");
      return;
    } catch (e: any) {
      console.error("⚠️ Falha ao descriptografar secrets.enc (verifique MASTER_PASSWORD):", e.message);
    }
  }
  
  // Fallback para leitura tradicional caso MASTER_PASSWORD não seja fornecido (ex: local dev)
  dotenv.config();
}
