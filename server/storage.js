// Uploaded files live in the channel's object store (S3_* env injected by xhostd).
// Without S3 env (local testing) they are written to <root>/.uploads instead.
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

let s3, bucket, localDir;

export function initStorage(root) {
  if (process.env.S3_ENDPOINT) {
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    });
    bucket = process.env.S3_BUCKET;
  } else {
    localDir = join(root, ".uploads");
    mkdirSync(localDir, { recursive: true });
  }
}

const safeLocal = (key) => {
  const p = normalize(join(localDir, key));
  if (!p.startsWith(localDir)) throw new Error("bad key");
  return p;
};

export async function putFile(key, buffer, contentType) {
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
  } else {
    const p = safeLocal(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buffer);
  }
}

export async function exists(key) {
  if (!s3) return existsSync(safeLocal(key));
  try {
    await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=0-0" }));
    return true;
  } catch {
    return false;
  }
}

/** Returns { stream, contentType, length } or null. */
export async function getFile(key) {
  if (!s3) {
    const p = safeLocal(key);
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    return { stream: createReadStream(p), length: statSync(p).size };
  }
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { stream: r.Body, contentType: r.ContentType, length: r.ContentLength };
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function listFiles() {
  if (!s3) {
    const out = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push({ key: relative(localDir, p).replaceAll("\\", "/"), size: statSync(p).size, modified: statSync(p).mtime });
      }
    };
    walk(localDir);
    return out;
  }
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key, size: o.Size, modified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function deleteFile(key) {
  if (s3) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  else rmSync(safeLocal(key), { force: true });
}
