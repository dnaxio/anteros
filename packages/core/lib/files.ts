import { getFileCollection } from "../database/file";
import { useRest } from "../database/rest";
import { cfg } from "../server/config";
import { AppError } from "./error";
import type { FileCollection } from "../types/file";
import path from "path";
import fs from "fs/promises";
import { createReadStream, existsSync, mkdirSync } from "fs";
import { ObjectId } from "mongodb";

// ─── Storage Interface ──────────────────────────────────────────────────────

export type FileResult = {
  _id: string;
  _file: {
    filename: string;
    name: string;
    mimetype: string;
    size: number;
    url: string;
  };
  metadata?: Record<string, unknown>;
};

export type UploadOptions = {
  collection: string;
  tenant_id: string;
  file: File;
  data?: Record<string, any>;
};

export type FileStorage = {
  save(tenant_id: string, collection: string, file: File, meta: {
    id: string;
    mimetype: string;
    subpath?: string;
  }): Promise<{ path: string; size: number }>;
  getStream(tenant_id: string, collection: string, fileId: string, filename: string, subpath?: string): Promise<ReadableStream | null>;
  delete(tenant_id: string, collection: string, fileId: string, filename: string, subpath?: string): Promise<void>;
};

// ─── Disk Storage ───────────────────────────────────────────────────────────

export function createDiskStorage(baseDir?: string): FileStorage {
  const root = baseDir ?? path.join(process.cwd(), 'storage');

  return {
    async save(tenant_id, collection, file, meta) {
      const { subpath } = meta;
      const dir = subpath ? path.join(root, subpath) : path.join(root, tenant_id, collection);
      await fs.mkdir(dir, { recursive: true });
      const ext = path.extname(file.name) || '';
      const filename = `${meta.id}${ext}`;
      const filepath = path.join(dir, filename);
      const buffer = await file.arrayBuffer();
      await fs.writeFile(filepath, new Uint8Array(buffer));
      const outPath = subpath ? `${subpath}/${filename}` : `${tenant_id}/${collection}/${filename}`;
      return { path: outPath, size: buffer.byteLength };
    },

    async getStream(tenant_id, collection, fileId, filename, subpath) {
      const filepath = subpath ? path.join(root, subpath, filename) : path.join(root, tenant_id, collection, filename);
      if (!existsSync(filepath)) return null;
      const file = Bun.file(filepath);
      return file.stream();
    },

    async delete(tenant_id, collection, fileId, filename, subpath) {
      const filepath = subpath ? path.join(root, subpath, filename) : path.join(root, tenant_id, collection, filename);
      await fs.unlink(filepath).catch(() => {});
    },
  };
}

// ─── S3 Storage ─────────────────────────────────────────────────────────────

export type S3Config = {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
};

export function createS3Storage(config: S3Config): FileStorage {
  return {
    async save(tenant_id, collection, file, meta) {
      const { subpath } = meta;
      const ext = path.extname(file.name) || '';
      const filename = `${meta.id}${ext}`;
      const key = subpath ? `${subpath}/${filename}` : `${tenant_id}/${collection}/${filename}`;
      const buffer = await file.arrayBuffer();
      // S3 upload via fetch (AWS S3 REST API)
      const url = config.endpoint
        ? `${config.endpoint}/${config.bucket}/${key}`
        : `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': meta.mimetype,
          'Content-Length': String(buffer.byteLength),
        },
        body: buffer,
      });
      if (!response.ok) {
        throw new AppError(`S3 upload failed: ${response.statusText}`, {
          code: 'S3_UPLOAD_ERROR', status: 500,
        });
      }
      return { path: key, size: buffer.byteLength };
    },

    async getStream(tenant_id, collection, fileId, filename, subpath) {
      const key = subpath ? `${subpath}/${filename}` : `${tenant_id}/${collection}/${filename}`;
      const url = config.endpoint
        ? `${config.endpoint}/${config.bucket}/${key}`
        : `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
      const response = await fetch(url);
      if (!response.ok) return null;
      return response.body;
    },

    async delete(tenant_id, collection, fileId, filename, subpath) {
      const key = subpath ? `${subpath}/${filename}` : `${tenant_id}/${collection}/${filename}`;
      const url = config.endpoint
        ? `${config.endpoint}/${config.bucket}/${key}`
        : `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
      await fetch(url, { method: 'DELETE' });
    },
  };
}

// ─── Image Transformations ─────────────────────────────────────────────────

export type TransformOptions = {
  width?: number;
  height?: number;
  format?: 'webp' | 'jpeg' | 'png' | 'avif';
  quality?: number;
};

async function transformImage(
  input: Uint8Array | ReadableStream,
  options: TransformOptions,
): Promise<{ data: Uint8Array; mimetype: string }> {
  const format = options.format || 'webp';
  const quality = options.quality ?? 80;

  // Convertir ReadableStream en Uint8Array si nécessaire
  let buffer: Uint8Array;
  if (input instanceof Uint8Array) {
    buffer = input;
  } else {
    const chunks: Uint8Array[] = [];
    const reader = input.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value!);
    }
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    buffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
  }

  // Utiliser Bun.Image (natif, zéro dépendance)
  const img = new Bun.Image(buffer);

  if (options.width || options.height) {
    img.resize(options.width ?? 0, options.height ?? 0, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Encoder dans le format demandé
  let out: Blob;
  switch (format) {
    case 'jpeg':
      out = await img.jpeg({ quality }).blob();
      break;
    case 'png':
      out = await img.png().blob();
      break;
    case 'avif':
      out = await img.avif({ quality }).blob();
      break;
    default: // webp
      out = await img.webp({ quality }).blob();
      break;
  }

  const data = new Uint8Array(await out.arrayBuffer());
  return { data, mimetype: `image/${format}` };
}

// ─── File Service ──────────────────────────────────────────────────────────

let _storage: FileStorage | null = null;

function resolveStorage(): FileStorage {
  if (_storage) return _storage;
  _storage = createDiskStorage();
  return _storage;
}

/**
 * Resolve the storage backend for a given file collection.
 * Falls back to disk storage if the collection or driver is not configured.
 */
export function getStorageForCollection(slug: string, tenant_id: string): FileStorage {
  const col = getFileCollection(slug, tenant_id);
  if (!col?.storage) return resolveStorage();
  const storage = col.storage;
  if (storage.driver === 's3') {
    return createS3Storage({
      region: storage.region || process.env.AWS_REGION || 'us-east-1',
      bucket: storage.bucket || process.env.AWS_BUCKET || '',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      endpoint: process.env.S3_ENDPOINT,
    });
  }
  return resolveStorage();
}

/**
 * Handle a file upload for a given collection.
 */
export async function handleUpload(options: UploadOptions): Promise<FileResult> {
  const { collection, tenant_id, file, data } = options;

  const col = getFileCollection(collection, tenant_id);
  if (!col) {
    throw new AppError(`File collection '${collection}' not found`, {
      code: 'FILE_COLLECTION_NOT_FOUND', status: 404,
    });
  }

  // Validate MIME type
  const mimetype = file.type || 'application/octet-stream';
  if (col.upload?.allowedMimeTypes?.length && !col.upload.allowedMimeTypes.includes(mimetype)) {
    throw new AppError(`MIME type '${mimetype}' not allowed`, {
      code: 'MIMETYPE_NOT_ALLOWED', status: 400,
    });
  }

  // Validate file size
  const maxSize = col.upload?.maxSize ?? 10 * 1024 * 1024; // 10MB default
  if (file.size > maxSize) {
    throw new AppError(`File too large (max ${Math.round(maxSize / 1024 / 1024)}MB)`, {
      code: 'FILE_TOO_LARGE', status: 413,
    });
  }

  // Insert metadata first to get the MongoDB auto-generated ObjectId
  let _id: string;
  try {
    const rest = new useRest({ tenant_id, internal: false, useHook: false, useCustomApi: false });
    const result = await rest.db.collection(collection).insertOne({
      _file: {
        filename: '',
        name: file.name,
        mimetype,
        size: 0,
        url: '',
      },
      ...(data || {}),
    });
    _id = String(result.insertedId);
  } catch (err) {
    throw new AppError('Failed to save file metadata', {
      code: 'FILE_METADATA_ERROR', status: 500,
    });
  }

  // Save the physical file to storage
  const ext = path.extname(file.name);
  const filename = `${_id}${ext}`;
  const storage = getStorageForCollection(collection, tenant_id);
  const subpath = col.storage?.path || undefined;
  const { path: filepath, size } = await storage.save(tenant_id, collection, file, { id: _id, mimetype, subpath });

  // Update MongoDB with actual file info
  const url = `/files/${tenant_id}/${collection}/${filename}`;
  try {
    const rest = new useRest({ tenant_id, internal: true, useHook: false, useCustomApi: false });
    await rest.db.collection(collection).updateOne(
      { _id: new ObjectId(_id) },
      { $set: { '_file.filename': filename, '_file.size': size, '_file.url': url } },
    );
  } catch (err) {
    await storage.delete(tenant_id, collection, _id, filename, subpath).catch(() => {});
    throw new AppError('Failed to update file metadata', {
      code: 'FILE_METADATA_ERROR', status: 500,
    });
  }

  // Replicate to configured destinations
  if (col.replicate?.length) {
    replicateFile(filepath, filename, col.replicate).catch(err => {
      console.error('Replication failed:', err?.message || err);
    });
  }

  return {
    _id,
    _file: {
      filename,
      name: file.name,
      mimetype,
      size,
      url,
    },
    ...(data || {}),
  };
}

/**
 * Serve a file with optional transformations.
 */
export async function handleServe(
  tenant_id: string,
  collection: string,
  fileId: string,
  filename: string,
  transform?: TransformOptions,
): Promise<{ stream: ReadableStream; mimetype: string; size?: number } | null> {
  const storage = getStorageForCollection(collection, tenant_id);
  const col = getFileCollection(collection, tenant_id);
  const subpath = col?.storage?.path || undefined;
  const stream = await storage.getStream(tenant_id, collection, fileId, filename, subpath);
  if (!stream) return null;

  let mimetype = getMimeType(filename);

  if (transform && (transform.width || transform.height || transform.format)) {
    const { data, mimetype: newMime } = await transformImage(stream, transform);
    return { stream: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }), mimetype: newMime, size: data.length };
  }

  return { stream, mimetype };
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.json': 'application/json', '.csv': 'text/csv',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

export async function handleDelete(
  tenant_id: string,
  collection: string,
  fileId: string,
): Promise<void> {
  const storage = getStorageForCollection(collection, tenant_id);
  const col = getFileCollection(collection, tenant_id);
  const subpath = col?.storage?.path || undefined;

  // Look up the document in MongoDB to get the stored filename
  let filename: string | undefined;
  try {
    const rest = new useRest({ tenant_id, internal: true, useHook: false, useCustomApi: false });
    const doc = await rest.db.collection(collection).findOne(
      { _id: ObjectId.isValid(fileId) ? new ObjectId(fileId) : fileId },
      { projection: { '_file.filename': 1 } },
    );
    filename = doc?._file?.filename;
  } catch {}

  // Delete the physical file from storage
  if (filename) {
    await storage.delete(tenant_id, collection, fileId, filename, subpath);
  } else {
    // Fallback: try common extensions using the fileId as base name
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg', '.pdf', '.mp4', '.webm', '.mp3', '.wav', '.json', '.csv', '.zip', '']) {
      try {
        await storage.delete(tenant_id, collection, fileId, fileId + ext, subpath);
        break;
      } catch {}
    }
  }

  // Delete the document from MongoDB
  try {
    const rest = new useRest({ tenant_id, internal: true, useHook: false, useCustomApi: false });
    await rest.db.collection(collection).deleteOne({
      _id: ObjectId.isValid(fileId) ? new ObjectId(fileId) : fileId,
    });
  } catch (err: any) {
    console.error('Failed to delete file metadata:', err?.message || err);
  }
}

// ─── Replication ──────────────────────────────────────────────────────────

type ReplicateTarget = NonNullable<NonNullable<ReturnType<typeof getFileCollection>>['replicate']>[number];

async function replicateToS3(target: ReplicateTarget, sourcePath: string, filename: string): Promise<void> {
  const storage = createS3Storage({
    region: target.region || process.env.AWS_REGION || 'us-east-1',
    bucket: target.bucket || '',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    endpoint: target.endpoint || process.env.S3_ENDPOINT,
  });

  const localPath = path.join(process.cwd(), sourcePath);
  const file = Bun.file(localPath);
  const exists = await file.exists();
  if (!exists) return;

  const buffer = await file.arrayBuffer();
  const fakeFile = new File([buffer], filename, { type: 'application/octet-stream' });
  const key = target.path ? `${target.path}/${filename}` : filename;
  await storage.save('replicate', 'replicate', fakeFile, { id: filename.replace(/\.[^.]+$/, ''), mimetype: 'application/octet-stream', subpath: target.path });
}

async function replicateToSSH(target: ReplicateTarget, sourcePath: string, filename: string): Promise<void> {
  const host = target.host || 'localhost';
  const port = target.port || 22;
  const username = target.username || process.env.USER || 'root';
  const remotePath = target.path ? `${target.path}/${filename}` : filename;
  const localPath = path.join(process.cwd(), sourcePath);

  const args = [
    'scp', '-P', String(port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ];

  // Add private key if provided
  if (target.privateKey) {
    args.push('-i', target.privateKey);
  }

  args.push(localPath, `${username}@${host}:${remotePath}`);

  const result = await Bun.spawn(args);
  await result.exited;
}

async function replicateToSFTP(target: ReplicateTarget, sourcePath: string, filename: string): Promise<void> {
  const host = target.host || 'localhost';
  const port = target.port || 22;
  const username = target.username || process.env.USER || 'root';
  const remotePath = target.path || '';
  const localPath = path.join(process.cwd(), sourcePath);

  const args = [
    'sftp', '-P', String(port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ];

  if (target.privateKey) {
    args.push('-i', target.privateKey);
  }

  args.push(`${username}@${host}`);

  const result = await Bun.spawn(args, {
    stdin: Buffer.from(`put "${localPath}" "${remotePath}/${filename}"\nquit\n`),
  });
  await result.exited;
}

async function replicateFile(sourcePath: string, filename: string, targets: ReplicateTarget[]): Promise<void> {
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      switch (target.driver) {
        case 's3':
          await replicateToS3(target, sourcePath, filename);
          break;
        case 'ssh':
          await replicateToSSH(target, sourcePath, filename);
          break;
        case 'sftp':
          await replicateToSFTP(target, sourcePath, filename);
          break;
      }
    })
  );

  // Log failures without throwing
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Replication failed:', result.reason?.message || result.reason);
    }
  }
}
