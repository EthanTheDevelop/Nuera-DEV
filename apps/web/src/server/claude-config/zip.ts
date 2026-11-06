import { crc32, inflateRawSync } from 'node:zlib';
import { AppError } from '@/server/errors';

/**
 * Minimal, defensive reader of a .zip upload (« Importer un skill »): central directory only, methods
 * « stored » and « deflate », no encryption, no ZIP64, no symbolic link, bounded entry count and sizes
 * (checked BEFORE inflating, and again on the inflated bytes, with the CRC). Nothing is written to
 * disk: entries come back as buffers for the skill validation (`skill-files.ts`).
 */

export interface ZipEntry {
  /** Name as stored (forward slashes). */
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

const refuse = (message: string) => new AppError('VALIDATION', message);

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(buffer: Buffer, limits: ZipLimits): ZipEntry[] {
  if (buffer.length < 22) throw refuse("Ce fichier n'est pas une archive .zip.");
  // End of central directory: last 22 bytes + comment (65 535 max).
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65_535); offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw refuse("Ce fichier n'est pas une archive .zip.");
  const disk = buffer.readUInt16LE(eocd + 4);
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const start = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw refuse('Archive .zip en plusieurs parties ou ZIP64 : non prise en charge.');
  if (count > limits.maxEntries) throw refuse(`Archive trop fournie : ${limits.maxEntries} fichiers au plus.`);
  if (start + size > eocd) throw refuse('Archive .zip corrompue.');

  const entries: ZipEntry[] = [];
  let total = 0;
  let pointer = start;
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CENTRAL) throw refuse('Archive .zip corrompue.');
    const versionMadeBy = buffer.readUInt16LE(pointer + 4);
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressed = buffer.readUInt32LE(pointer + 20);
    const uncompressed = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const external = buffer.readUInt32LE(pointer + 38);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    pointer += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw refuse('Archive chiffrée : non prise en charge.');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw refuse('Archive ZIP64 : non prise en charge.');
    // Unix mode in the upper 16 bits when made on Unix (host 3): a symbolic link is refused.
    const unixMode = versionMadeBy >> 8 === 3 ? external >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw refuse(`Lien symbolique refusé : ${name}.`);
    if (name.endsWith('/')) continue; // folder entry
    if (method !== 0 && method !== 8) throw refuse(`Méthode de compression non prise en charge : ${name}.`);
    if (uncompressed > limits.maxEntryBytes) throw refuse(`Fichier trop volumineux : ${name}.`);
    total += uncompressed;
    if (total > limits.maxTotalBytes) throw refuse('Archive trop volumineuse une fois décompressée.');

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw refuse('Archive .zip corrompue.');
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    if (dataStart + compressed > buffer.length) throw refuse('Archive .zip corrompue.');
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressed) });
    } catch {
      throw refuse(`Fichier illisible dans l'archive : ${name}.`);
    }
    if (data.length !== uncompressed || crc32(data) >>> 0 !== crc >>> 0) throw refuse(`Fichier corrompu dans l'archive : ${name}.`);
    entries.push({ name, data });
  }
  return entries;
}
