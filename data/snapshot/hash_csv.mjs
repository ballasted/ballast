import { keccak256, toHex } from "viem";
import fs from "node:fs";

const dir = "C:/Users/Lenovo/ballast/data/snapshot/";
const csv = fs.readFileSync(dir + "v1_snapshot.csv");
const hash = keccak256(toHex(csv));
console.log(hash);

const meta = JSON.parse(fs.readFileSync(dir + "meta.json", "utf8"));
meta.csvKeccak256 = hash;
fs.writeFileSync(dir + "meta.json", JSON.stringify(meta, null, 2));
